import { spawn, execSync, type ChildProcess } from 'child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';

import { type DiffComment } from '../types/diff.js';
import { reviewContextToDiffComments } from './findingsAdapter.js';

// Types mirrored from review-flow (we import the built JS at runtime)
interface ReviewContextAgent {
  name: string;
  displayName: string;
}

interface ReviewContextProgress {
  phase:
    | 'pending'
    | 'initializing'
    | 'agents-running'
    | 'synthesizing'
    | 'publishing'
    | 'completed';
  currentStep: string | null;
  stepsCompleted?: string[];
  agents?: ReviewContextAgent[];
  updatedAt?: string;
}

interface ReviewContextAction {
  type: string;
  filePath?: string;
  line?: number;
  body?: string;
  threadId?: string;
  message?: string;
  label?: string;
}

interface ReviewContextResult {
  blocking: number;
  warnings: number;
  suggestions: number;
  score: number;
  verdict: 'ready_to_merge' | 'needs_fixes' | 'needs_discussion';
  findings?: Array<{
    severity: 'blocking' | 'warning' | 'suggestion';
    description: string;
    file?: string;
    line?: number;
  }>;
}

interface ReviewContext {
  version: string;
  mergeRequestId: string;
  platform: 'github' | 'gitlab';
  projectPath: string;
  mergeRequestNumber: number;
  createdAt: string;
  threads: unknown[];
  actions: ReviewContextAction[];
  progress: ReviewContextProgress;
  result?: ReviewContextResult;
}

type AgentStatus = 'pending' | 'running' | 'completed' | 'failed';
type ReviewPhase = 'initializing' | 'agents-running' | 'synthesizing' | 'publishing' | 'completed';

interface AgentProgress {
  name: string;
  displayName: string;
  status: AgentStatus;
}

interface ReviewProgress {
  phase: ReviewPhase;
  agents: AgentProgress[];
  overallProgress: number;
}

export interface ReviewResult {
  blocking: number;
  warnings: number;
  suggestions: number;
  score: number;
  verdict: string;
}

export type ReviewEventType = 'progress' | 'finding' | 'complete' | 'error';

export interface ReviewEvent {
  type: ReviewEventType;
  phase?: string;
  agents?: AgentProgress[];
  overallProgress?: number;
  comment?: DiffComment;
  result?: ReviewResult;
  message?: string;
  fixedIds?: string[];
}

type EventListener = (event: ReviewEvent) => void;

const DEFAULT_AGENTS: ReviewContextAgent[] = [
  { name: 'clean-architecture', displayName: 'Clean Archi' },
  { name: 'ddd', displayName: 'DDD' },
  { name: 'react-best-practices', displayName: 'React' },
  { name: 'solid', displayName: 'SOLID' },
  { name: 'testing', displayName: 'Testing' },
  { name: 'code-quality', displayName: 'Code Quality' },
  { name: 'threads', displayName: 'Threads' },
  { name: 'report', displayName: 'Rapport' },
];

const DEFAULT_FIX_AGENTS: ReviewContextAgent[] = [
  { name: 'context', displayName: 'Contexte' },
  { name: 'apply-fixes', displayName: 'Corrections' },
  { name: 'commit', displayName: 'Commit & Push' },
  { name: 'report', displayName: 'Rapport' },
];

function resolveReviewFlowPath(): string {
  // Find review-flow dist relative to difit
  const candidates = [
    join(dirname(new URL(import.meta.url).pathname), '..', '..', 'node_modules', 'reviewflow'),
    join(process.cwd(), 'node_modules', 'reviewflow'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dist'))) return candidate;
  }
  throw new Error('review-flow not found. Run pnpm install in difit.');
}

function resolveMcpServerPath(): string {
  const rfPath = resolveReviewFlowPath();
  const mcpPath = join(rfPath, 'dist', 'mcpServer.js');
  if (!existsSync(mcpPath)) {
    throw new Error(`MCP server not found at ${mcpPath}. Build review-flow first.`);
  }
  return mcpPath;
}

function sanitizeJobId(jobId: string): string {
  return jobId.replace(/[:/\\]/g, '-');
}

function getJobContextFilePath(jobId: string): string {
  const jobsDir = join(homedir(), '.claude-review', 'jobs');
  return join(jobsDir, `${sanitizeJobId(jobId)}.json`);
}

function resolveClaudePath(): string {
  // Try common locations
  const candidates = [
    '/usr/local/bin/claude',
    join(homedir(), '.claude', 'local', 'claude'),
    'claude', // rely on PATH
  ];
  for (const candidate of candidates) {
    if (candidate === 'claude' || existsSync(candidate)) return candidate;
  }
  return 'claude';
}

function getCurrentBranch(repoPath: string): string | null {
  try {
    return (
      execSync('git branch --show-current', { cwd: repoPath, encoding: 'utf-8' }).trim() || null
    );
  } catch {
    return null;
  }
}

export class LocalReviewOrchestrator {
  private currentJobId: string | null = null;
  private mergeRequestId: string | null = null;
  private reviewMergeRequestId: string | null = null; // persists the review context ID across fixes
  private repoPath: string | null = null;
  private childProcess: ChildProcess | null = null;
  private abortController: AbortController | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastActionCount = 0;
  private lastPhase: string | null = null;
  private completedEmitted = false;
  private emittedFindingIds = new Set<string>();
  private listeners: EventListener[] = [];
  private lastResult: ReviewResult | null = null;

  /**
   * Try to restore the last completed review from disk so that
   * restarting difit still shows previous findings without re-running.
   */
  tryRestoreLastReview(repoPath: string): boolean {
    const logsDir = join(repoPath, '.claude', 'reviews', 'logs');
    if (!existsSync(logsDir)) {
      console.log('[review-restore] No logs dir found at', logsDir);
      return false;
    }

    const currentBranch = getCurrentBranch(repoPath);
    console.log(`[review-restore] Current branch: ${currentBranch ?? '(detached)'}`);

    try {
      const files = readdirSync(logsDir)
        .filter((f) => f.startsWith('local-') && f.endsWith('.json') && !f.includes('-fix-'))
        .sort()
        .reverse(); // most recent first (timestamp in name)

      console.log(`[review-restore] Found ${files.length} review log files`);

      for (const file of files) {
        const filePath = join(logsDir, file);
        try {
          const context = JSON.parse(readFileSync(filePath, 'utf-8')) as ReviewContext & {
            branch?: string | null;
          };
          if (!context.result) continue;

          // Skip if review was for a different branch
          if (context.branch && currentBranch && context.branch !== currentBranch) {
            continue;
          }

          // Found a completed review for this branch — restore
          this.repoPath = repoPath;
          this.mergeRequestId = file.replace('.json', '');
          this.reviewMergeRequestId = this.mergeRequestId;
          this.lastResult = {
            blocking: context.result.blocking,
            warnings: context.result.warnings,
            suggestions: context.result.suggestions,
            score: context.result.score,
            verdict: context.result.verdict,
          };
          console.log(
            `[review-restore] Restored review from ${file} (branch=${context.branch ?? 'unknown'}, score=${context.result.score}, findings=${reviewContextToDiffComments(context).length})`,
          );
          return true;
        } catch {
          continue;
        }
      }
      console.log('[review-restore] No completed review found for current branch');
    } catch (err) {
      console.log('[review-restore] Error scanning logs:', err);
    }
    return false;
  }

  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: ReviewEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private computeAgentStatuses(context: ReviewContext): AgentProgress[] {
    const agents: AgentProgress[] = (context.progress.agents ?? []).map((a) => ({
      name: a.name,
      displayName: a.displayName,
      status: 'pending' as AgentStatus,
    }));

    const completedSteps = new Set(context.progress.stepsCompleted ?? []);
    for (const agent of agents) {
      if (completedSteps.has(agent.name)) {
        agent.status = 'completed';
      } else if (context.progress.currentStep === agent.name) {
        agent.status = 'running';
      }
    }
    return agents;
  }

  private computeOverallProgress(agents: AgentProgress[]): number {
    const totalAgents = agents.length || 1;
    const completedCount = agents.filter((a) => a.status === 'completed').length;
    const runningCount = agents.filter((a) => a.status === 'running').length;
    return Math.round(((completedCount + runningCount * 0.5) / totalAgents) * 100);
  }

  getProgress(): ReviewProgress | null {
    if (!this.repoPath || !this.mergeRequestId) return null;
    const context = this.readContext();
    if (!context) return null;
    const agents = this.computeAgentStatuses(context);
    return {
      phase: (context.progress.phase === 'pending'
        ? 'initializing'
        : context.progress.phase) as ReviewPhase,
      agents,
      overallProgress: this.computeOverallProgress(agents),
    };
  }

  getFindings(): DiffComment[] {
    const context = this.readContext();
    if (!context) return [];
    return reviewContextToDiffComments(context);
  }

  getResult(): ReviewResult | null {
    if (this.lastResult) return this.lastResult;
    const context = this.readContext();
    if (!context?.result) return null;
    return {
      blocking: context.result.blocking,
      warnings: context.result.warnings,
      suggestions: context.result.suggestions,
      score: context.result.score,
      verdict: context.result.verdict,
    };
  }

  /** Returns a full snapshot for late-connecting SSE clients. */
  getSnapshot(): {
    progress: ReviewProgress | null;
    findings: DiffComment[];
    result: ReviewResult | null;
  } {
    return {
      progress: this.getProgress(),
      findings: this.getFindings(),
      result: this.getResult(),
    };
  }

  startReview(repoPath: string, base: string, target: string, skill?: string): string {
    if (this.currentJobId) {
      this.stopReview();
    }

    this.repoPath = repoPath;
    const repoName = basename(repoPath);
    const jobId = `local-${Date.now()}`;
    this.currentJobId = jobId;
    this.mergeRequestId = `local-${repoName}-${jobId}`;
    this.reviewMergeRequestId = this.mergeRequestId;
    this.lastActionCount = 0;
    this.lastPhase = null;
    this.completedEmitted = false;
    this.lastResult = null;
    this.emittedFindingIds.clear();
    this.abortController = new AbortController();

    // Load repo-specific review config if available
    const repoConfig = this.loadRepoConfig(repoPath);
    const agents = repoConfig?.agents ?? DEFAULT_AGENTS;
    // Use config's skill if no explicit skill was passed (or if the default 'review' was used)
    if ((!skill || skill === 'review') && repoConfig?.reviewSkill) {
      skill = repoConfig.reviewSkill;
    }

    // Create ReviewContext JSON file
    const contextFilePath = join(
      repoPath,
      '.claude',
      'reviews',
      'logs',
      `${this.mergeRequestId}.json`,
    );
    const contextDir = dirname(contextFilePath);
    if (!existsSync(contextDir)) {
      mkdirSync(contextDir, { recursive: true });
    }

    const context: ReviewContext & { branch?: string | null } = {
      version: '1.0',
      mergeRequestId: this.mergeRequestId,
      platform: 'github',
      projectPath: repoName,
      mergeRequestNumber: 0,
      createdAt: new Date().toISOString(),
      threads: [],
      actions: [],
      progress: {
        phase: 'pending',
        currentStep: null,
        agents,
      },
      branch: getCurrentBranch(repoPath),
    };

    writeFileSync(contextFilePath, JSON.stringify(context, null, 2));

    // Write MCP job context
    const jobContextPath = getJobContextFilePath(jobId);
    const jobContextDir = dirname(jobContextPath);
    if (!existsSync(jobContextDir)) {
      mkdirSync(jobContextDir, { recursive: true });
    }
    writeFileSync(
      jobContextPath,
      JSON.stringify(
        {
          jobId,
          localPath: repoPath,
          mergeRequestId: this.mergeRequestId,
          jobType: 'review',
          platform: 'github',
          projectPath: repoName,
          sourceBranch: target,
          targetBranch: base,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // Build local system prompt
    const systemPrompt = this.buildLocalSystemPrompt(
      jobId,
      repoPath,
      repoName,
      base,
      target,
      skill ?? 'review',
    );

    // Build MCP config
    const mcpServerPath = resolveMcpServerPath();
    const mcpConfig = JSON.stringify({
      mcpServers: {
        'review-progress': {
          command: 'node',
          args: [mcpServerPath],
        },
      },
    });

    // Resolve skill name — auto-detect from repo's .claude/skills/ if the default is used
    const resolvedSkill = this.resolveSkillName(repoPath, skill ?? 'review');
    console.log(`[review] Resolved skill: ${resolvedSkill} (requested: ${skill ?? 'review'})`);

    // Build Claude args
    const prompt = `/${resolvedSkill} local`;
    const args = [
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--append-system-prompt',
      systemPrompt,
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      '--allowedTools',
      'Read,Glob,Grep,Bash,Edit,Task,Skill,Write,LSP,mcp__review-progress__*',
      '--disallowedTools',
      'EnterPlanMode,AskUserQuestion',
      '-p',
      prompt,
    ];

    // Spawn Claude
    const claudePath = resolveClaudePath();
    console.log(`[review] Spawning Claude: ${claudePath}`);
    console.log(`[review] CWD: ${repoPath}`);
    console.log(`[review] Prompt: ${prompt}`);
    console.log(`[review] MCP server: ${mcpServerPath}`);
    const childEnv = { ...process.env, CLAUDECODE: undefined, TERM: 'dumb', CI: 'true' };
    this.childProcess = spawn(claudePath, args, {
      cwd: repoPath,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Log stdout for debugging
    let stdoutBuffer = '';
    this.childProcess.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      if (stdoutBuffer.length < 5000) {
        // Log first bits of output to help debug
        console.log('[review-stdout]', data.toString().substring(0, 300));
      }
    });

    this.childProcess.on('close', (code) => {
      console.log(
        `[review] Claude process exited with code ${code}, stdout length: ${stdoutBuffer.length}`,
      );
      this.cleanupJobContext(jobId);
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      // Final read of context for result (only emit if not already emitted by polling)
      if (!this.completedEmitted) {
        const finalContext = this.readContext();
        if (finalContext?.result) {
          this.completedEmitted = true;
          this.lastResult = {
            blocking: finalContext.result.blocking,
            warnings: finalContext.result.warnings,
            suggestions: finalContext.result.suggestions,
            score: finalContext.result.score,
            verdict: finalContext.result.verdict,
          };
          // Also emit any remaining findings
          const allFindings = reviewContextToDiffComments(finalContext);
          for (const comment of allFindings) {
            if (!this.emittedFindingIds.has(comment.id)) {
              this.emittedFindingIds.add(comment.id);
              this.emit({ type: 'finding', comment });
            }
          }
          this.emit({ type: 'complete', result: this.lastResult });
        } else {
          this.emit({
            type: code === 0 ? 'complete' : 'error',
            result:
              code === 0
                ? {
                    blocking: 0,
                    warnings: 0,
                    suggestions: 0,
                    score: 100,
                    verdict: 'ready_to_merge',
                  }
                : undefined,
            message: code !== 0 ? `Review process exited with code ${code}` : undefined,
          });
        }
      }

      this.currentJobId = null;
      this.childProcess = null;
    });

    this.childProcess.on('error', (err) => {
      this.emit({ type: 'error', message: err.message });
      this.currentJobId = null;
      this.childProcess = null;
    });

    this.childProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error('[review-stderr]', msg.substring(0, 200));
      }
    });

    // Cancellation
    const signal = this.abortController.signal;
    signal.addEventListener(
      'abort',
      () => {
        this.childProcess?.kill('SIGTERM');
        setTimeout(() => {
          if (this.childProcess && !this.childProcess.killed) {
            this.childProcess.kill('SIGKILL');
          }
        }, 5000);
      },
      { once: true },
    );

    // Start polling the ReviewContext file
    this.startPolling();

    return jobId;
  }

  startFix(repoPath: string, findingIds: string[]): string {
    if (this.currentJobId) {
      this.stopReview();
    }

    // Read the review context (not a previous fix context) to get findings
    const savedMergeRequestId = this.mergeRequestId;
    if (this.reviewMergeRequestId) {
      this.mergeRequestId = this.reviewMergeRequestId;
    }
    console.log(
      `[fix] Reading review context: repoPath=${repoPath}, mergeRequestId=${this.mergeRequestId}`,
    );
    const previousContext = this.readContext();
    console.log(`[fix] Context actions count: ${previousContext?.actions?.length ?? 'null'}`);
    const allDiffComments = previousContext ? reviewContextToDiffComments(previousContext) : [];
    console.log(`[fix] All DiffComment IDs: ${allDiffComments.map((c) => c.id).join(', ')}`);
    console.log(`[fix] Requested findingIds: ${findingIds.join(', ')}`);
    const selectedDiffComments = allDiffComments.filter((c) => findingIds.includes(c.id));
    console.log(`[fix] Matched ${selectedDiffComments.length}/${findingIds.length} findings`);
    // Restore mergeRequestId before overwriting with fix context
    this.mergeRequestId = savedMergeRequestId;

    // Build the findings descriptions to pass to the fix agent
    const selectedFindings = selectedDiffComments.map((c) => {
      const line = c.position?.line;
      return {
        severity: c.severity ?? 'suggestion',
        description: c.body,
        file: c.filePath,
        line:
          typeof line === 'number'
            ? line
            : typeof line === 'object' && line
              ? line.start
              : undefined,
      };
    });

    this.repoPath = repoPath;
    const repoName = basename(repoPath);
    const jobId = `local-fix-${Date.now()}`;
    this.currentJobId = jobId;
    this.mergeRequestId = `local-fix-${repoName}-${jobId}`;
    this.lastActionCount = 0;
    this.lastPhase = null;
    this.completedEmitted = false;
    this.lastResult = null;
    this.emittedFindingIds.clear();
    this.abortController = new AbortController();
    const fixingIds = findingIds;

    const contextFilePath = join(
      repoPath,
      '.claude',
      'reviews',
      'logs',
      `${this.mergeRequestId}.json`,
    );
    const contextDir = dirname(contextFilePath);
    if (!existsSync(contextDir)) {
      mkdirSync(contextDir, { recursive: true });
    }

    const context = {
      version: '1.0',
      mergeRequestId: this.mergeRequestId,
      platform: 'github' as const,
      projectPath: repoName,
      mergeRequestNumber: 0,
      createdAt: new Date().toISOString(),
      threads: [],
      actions: [],
      progress: {
        phase: 'pending' as const,
        currentStep: null,
        agents: DEFAULT_FIX_AGENTS,
      },
      previousFindings:
        selectedFindings.length > 0
          ? selectedFindings
          : allDiffComments.map((c) => {
              const ln = c.position?.line;
              return {
                severity: c.severity ?? 'suggestion',
                description: c.body,
                file: c.filePath,
                line:
                  typeof ln === 'number' ? ln : typeof ln === 'object' && ln ? ln.start : undefined,
              };
            }),
    };

    writeFileSync(contextFilePath, JSON.stringify(context, null, 2));

    const jobContextPath = getJobContextFilePath(jobId);
    const jobContextDir = dirname(jobContextPath);
    if (!existsSync(jobContextDir)) {
      mkdirSync(jobContextDir, { recursive: true });
    }
    writeFileSync(
      jobContextPath,
      JSON.stringify(
        {
          jobId,
          localPath: repoPath,
          mergeRequestId: this.mergeRequestId,
          jobType: 'fix',
          platform: 'github',
          projectPath: repoName,
          sourceBranch: 'HEAD',
          targetBranch: 'HEAD',
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    const systemPrompt = this.buildFixSystemPrompt(jobId, repoPath, repoName);
    const mcpServerPath = resolveMcpServerPath();
    const mcpConfig = JSON.stringify({
      mcpServers: {
        'review-progress': {
          command: 'node',
          args: [mcpServerPath],
        },
      },
    });

    const args = [
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--append-system-prompt',
      systemPrompt,
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      '--allowedTools',
      'Read,Glob,Grep,Bash,Edit,Task,Skill,Write,LSP,mcp__review-progress__*',
      '--disallowedTools',
      'EnterPlanMode,AskUserQuestion',
      '-p',
      this.buildFixPrompt(
        selectedFindings.length > 0
          ? selectedFindings
          : allDiffComments.map((c) => {
              const line = c.position?.line;
              return {
                severity: c.severity ?? 'suggestion',
                description: c.body,
                file: c.filePath,
                line:
                  typeof line === 'number'
                    ? line
                    : typeof line === 'object' && line
                      ? line.start
                      : undefined,
              };
            }),
      ),
    ];

    const claudePath = resolveClaudePath();
    console.log(`[fix] Spawning: ${claudePath} ${args.join(' ').substring(0, 200)}...`);
    const childEnv = { ...process.env, CLAUDECODE: undefined, TERM: 'dumb', CI: 'true' };
    this.childProcess = spawn(claudePath, args, {
      cwd: repoPath,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.childProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[fix stdout] ${data.toString().trim().substring(0, 500)}`);
    });
    this.childProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[fix stderr] ${data.toString().trim().substring(0, 500)}`);
    });

    this.childProcess.on('close', (code) => {
      console.log(`[fix] Claude process exited with code ${code}`);
      this.cleanupJobContext(jobId);
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
      this.emit({
        type: 'complete',
        result: { blocking: 0, warnings: 0, suggestions: 0, score: 100, verdict: 'fixed' },
        fixedIds: fixingIds,
      });
      this.currentJobId = null;
      this.childProcess = null;
      // Restore review context ID so subsequent fixes can read the review findings
      if (this.reviewMergeRequestId) {
        this.mergeRequestId = this.reviewMergeRequestId;
      }
    });

    this.childProcess.on('error', (err) => {
      this.emit({ type: 'error', message: err.message });
    });

    this.startPolling();
    return jobId;
  }

  stopReview(): void {
    this.abortController?.abort();
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.currentJobId = null;
  }

  isRunning(): boolean {
    return this.currentJobId !== null;
  }

  private readContext(): ReviewContext | null {
    if (!this.repoPath || !this.mergeRequestId) return null;
    const filePath = join(
      this.repoPath,
      '.claude',
      'reviews',
      'logs',
      `${this.mergeRequestId}.json`,
    );
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as ReviewContext;
    } catch {
      return null;
    }
  }

  private startPolling(): void {
    this.pollInterval = setInterval(() => {
      this.pollContext();
    }, 1500);
  }

  private pollContext(): void {
    const context = this.readContext();
    if (!context) return;

    // Check for phase changes or agent status changes
    const currentPhase = context.progress.phase;
    const currentStep = context.progress.currentStep;
    const stepsKey = (context.progress.stepsCompleted ?? []).join(',');
    const phaseKey = `${currentPhase}:${currentStep ?? ''}:${stepsKey}`;

    if (phaseKey !== this.lastPhase) {
      this.lastPhase = phaseKey;

      const agents = this.computeAgentStatuses(context);
      const overallProgress = this.computeOverallProgress(agents);

      this.emit({
        type: 'progress',
        phase: currentPhase === 'pending' ? 'initializing' : currentPhase,
        agents,
        overallProgress,
      });
    }

    // Check for new actions (findings)
    if (context.actions.length > this.lastActionCount) {
      // Always compute IDs from the full action list for consistent indexing
      const allComments = reviewContextToDiffComments(context);
      this.lastActionCount = context.actions.length;

      for (const comment of allComments) {
        if (!this.emittedFindingIds.has(comment.id)) {
          this.emittedFindingIds.add(comment.id);
          this.emit({ type: 'finding', comment });
        }
      }
    }

    // Check for result (emit only once)
    if (context.result && !this.completedEmitted) {
      this.completedEmitted = true;
      this.lastResult = {
        blocking: context.result.blocking,
        warnings: context.result.warnings,
        suggestions: context.result.suggestions,
        score: context.result.score,
        verdict: context.result.verdict,
      };
      this.emit({
        type: 'complete',
        result: this.lastResult,
      });
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    }
  }

  private cleanupJobContext(jobId: string): void {
    try {
      const filePath = getJobContextFilePath(jobId);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }

  private loadRepoConfig(
    repoPath: string,
  ): { reviewSkill?: string; agents?: ReviewContextAgent[] } | null {
    const configPath = join(repoPath, '.claude', 'reviews', 'config.json');
    if (!existsSync(configPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        reviewSkill?: string;
        agents?: ReviewContextAgent[];
      };
      if (raw.reviewSkill || raw.agents) {
        console.log(
          `[review] Loaded repo config: skill=${raw.reviewSkill ?? 'default'}, agents=${raw.agents?.length ?? 0}`,
        );
      }
      return raw;
    } catch {
      return null;
    }
  }

  private resolveSkillName(repoPath: string, requestedSkill: string): string {
    const skillsDir = join(repoPath, '.claude', 'skills');
    if (!existsSync(skillsDir)) return requestedSkill;

    // Check if the exact skill exists
    if (existsSync(join(skillsDir, requestedSkill))) return requestedSkill;

    // Auto-detect: find skill directories starting with the requested name
    try {
      const dirs = readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith(requestedSkill))
        .map((d) => d.name);

      if (dirs.length === 1) return dirs[0];
      // Prefer "-code" suffix (most common review skill pattern)
      const preferred = dirs.find((d) => d === `${requestedSkill}-code`);
      if (preferred) return preferred;
      if (dirs.length > 0) return dirs[0];
    } catch {
      // ignore
    }

    return requestedSkill;
  }

  private buildGitDiffCommand(base: string, target: string): string {
    // Handle special targets like "." (all uncommitted), "working", "staged"
    if (target === '.' || target === 'working') {
      return base === 'HEAD' || base === 'HEAD^' ? `git diff ${base}` : `git diff ${base}`;
    }
    if (target === 'staged') {
      return `git diff --cached ${base}`;
    }
    return `git diff ${base}..${target}`;
  }

  private buildLocalSystemPrompt(
    jobId: string,
    _repoPath: string,
    repoName: string,
    base: string,
    target: string,
    _skill: string,
  ): string {
    // Compute the actual git diff command depending on target type
    const gitDiffCommand = this.buildGitDiffCommand(base, target);

    return `
# AUTOMATED LOCAL REVIEW MODE - EXECUTE IMMEDIATELY

## CRITICAL EXECUTION RULES

You are running in FULLY AUTOMATED, NON-INTERACTIVE LOCAL REVIEW mode.
- **EXECUTE the skill instructions step by step RIGHT NOW**
- Do NOT produce a "plan" or "summary" of what you will do
- Do NOT wait for approval, confirmation, or user input
- Do NOT use EnterPlanMode or AskUserQuestion (they are disabled)
- Your output goes to a log file, not to a human

## LOCAL MODE — NO GITHUB/GITLAB INTERACTION

This is a LOCAL-ONLY review. You MUST NOT:
- Post anything on GitHub or GitLab
- Use gh api, glab, or any remote API calls
- Push, pull, or interact with any remote repository

## Data Source

**SOURCE OF TRUTH for the diff**: \`${gitDiffCommand}\`
This is a local diff review. Use git diff locally — this is the correct behavior for local mode.

## Your Job Context
- **Job ID**: \`${jobId}\`
- **Job Type**: review
- **Project**: ${repoName}
- **Base**: ${base}
- **Target**: ${target}

## MANDATORY MCP Tools Usage

You MUST use these MCP tools for ALL operations.

### Phase Management
\`\`\`
set_phase({ jobId: "${jobId}", phase: "initializing" })
set_phase({ jobId: "${jobId}", phase: "agents-running" })
set_phase({ jobId: "${jobId}", phase: "synthesizing" })
set_phase({ jobId: "${jobId}", phase: "publishing" })
set_phase({ jobId: "${jobId}", phase: "completed" })
\`\`\`

### Agent Progress (call for EACH audit/step)
\`\`\`
start_agent({ jobId: "${jobId}", agentName: "agent-name" })
complete_agent({ jobId: "${jobId}", agentName: "agent-name", status: "success" })
\`\`\`

### Recording Findings (USE add_action — do NOT post anywhere)
\`\`\`
add_action({ jobId: "${jobId}", type: "POST_INLINE_COMMENT", filePath: "src/file.ts", line: 42, body: "..." })
\`\`\`
Use emoji prefixes for severity: 🔴 for blocking, 🟡 for warning, 🔵 for suggestion.

### Review Result (MANDATORY)
\`\`\`
set_result({ jobId: "${jobId}", blocking: X, warnings: X, suggestions: X, score: X, verdict: "ready_to_merge"|"needs_fixes"|"needs_discussion", findings: [...] })
\`\`\`
You MUST call set_result before set_phase({ phase: "completed" }).

## Workflow

1. set_phase({ phase: "initializing" })
2. Read the diff via \`${gitDiffCommand}\`
3. For each audit domain: start_agent → analyze → add_action for findings → complete_agent
4. set_phase({ phase: "synthesizing" })
5. Synthesize results
6. set_phase({ phase: "publishing" })
7. set_result({ ... })
8. set_phase({ phase: "completed" })

## Language

Write all review comments and findings in English.
`.trim();
  }

  private buildFixPrompt(
    findings: Array<{ severity: string; description: string; file?: string; line?: number }>,
  ): string {
    const findingsList = findings
      .map(
        (f, i) =>
          `${i + 1}. [${f.severity}] ${f.file ?? 'unknown'}${f.line ? `:${f.line}` : ''} — ${f.description}`,
      )
      .join('\n');

    return `Fix the following code review findings. Apply minimal, targeted fixes only.

## Findings to fix

${findingsList}

## Instructions

1. Read each file mentioned above
2. Apply the minimal fix for each finding
3. Do NOT add unrelated changes
4. Do NOT run git add, git commit, or git push
5. Do NOT stage or commit anything — just edit the files`;
  }

  private buildFixSystemPrompt(jobId: string, _repoPath: string, repoName: string): string {
    return `
# AUTOMATED LOCAL FIX MODE - EXECUTE IMMEDIATELY

You are running in FULLY AUTOMATED, NON-INTERACTIVE FIX mode.
- **EXECUTE fixes step by step RIGHT NOW**
- Apply minimal, targeted fixes to address each finding listed in the prompt
- Do NOT refactor unrelated code
- **CRITICAL: Do NOT run git add, git commit, or git push**
- **Just edit the files in place — the user will commit when ready**

## LOCAL MODE — NO GIT OPERATIONS
Do NOT use gh, glab, or any git commands. Do NOT commit. Do NOT push.
Only use Read and Edit tools to apply fixes.

## Your Job Context
- **Job ID**: \`${jobId}\`
- **Job Type**: fix
- **Project**: ${repoName}

## MCP Tools
Use set_phase, start_agent, complete_agent, and set_result as documented.
`.trim();
  }
}

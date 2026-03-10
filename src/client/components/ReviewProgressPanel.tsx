import { Loader2, CheckCircle, XCircle, AlertTriangle, Square, Bot } from 'lucide-react';

type AgentStatus = 'pending' | 'running' | 'completed' | 'failed';

interface AgentProgress {
  name: string;
  displayName: string;
  status: AgentStatus;
}

interface ReviewProgressData {
  phase: string;
  agents: AgentProgress[];
  overallProgress: number;
}

interface ReviewResult {
  blocking: number;
  warnings: number;
  suggestions: number;
  score: number;
  verdict: string;
}

interface ReviewProgressPanelProps {
  isReviewing: boolean;
  isFixing: boolean;
  progress: ReviewProgressData | null;
  result: ReviewResult | null;
  error: string | null;
  findingsCount: { blocking: number; warnings: number; suggestions: number };
  onStop: () => void;
  onFixBlocking: () => void;
  onFixAll: () => void;
}

const phaseLabels: Record<string, string> = {
  initializing: 'Initializing...',
  'agents-running': 'Reviewing...',
  synthesizing: 'Synthesizing...',
  publishing: 'Finalizing...',
  completed: 'Complete',
};

function AgentStatusIcon({ status }: { status: AgentStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 size={12} className="animate-spin text-blue-400" />;
    case 'completed':
      return <CheckCircle size={12} className="text-green-500" />;
    case 'failed':
      return <XCircle size={12} className="text-red-500" />;
    default:
      return <Square size={12} className="text-github-text-muted" />;
  }
}

const verdictLabels: Record<string, { label: string; color: string }> = {
  ready_to_merge: { label: 'Ready to merge', color: 'text-green-500' },
  needs_fixes: { label: 'Needs fixes', color: 'text-red-500' },
  needs_discussion: { label: 'Needs discussion', color: 'text-amber-500' },
};

export function ReviewProgressPanel({
  isReviewing,
  isFixing,
  progress,
  result,
  error,
  findingsCount,
  onStop,
  onFixBlocking,
  onFixAll,
}: ReviewProgressPanelProps) {
  if (!isReviewing && !result && !error) return null;

  return (
    <div
      id="review-progress-panel"
      className="mx-4 mt-3 mb-1 bg-github-bg-secondary border border-github-border rounded-lg shadow-sm overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-github-border bg-github-bg-tertiary">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-blue-400" />
          <span className="text-sm font-medium text-github-text-primary">AI Review</span>
          {!isReviewing && result ? (
            <span className="text-xs text-green-500">Complete</span>
          ) : (
            progress && (
              <span className="text-xs text-github-text-secondary">
                {phaseLabels[progress.phase] ?? progress.phase}
              </span>
            )
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Severity counters */}
          {(findingsCount.blocking > 0 ||
            findingsCount.warnings > 0 ||
            findingsCount.suggestions > 0) && (
            <div className="flex items-center gap-2 text-xs">
              {findingsCount.blocking > 0 && (
                <span className="text-red-500" title="Blocking">
                  {'\u{1F534}'} {findingsCount.blocking}
                </span>
              )}
              {findingsCount.warnings > 0 && (
                <span className="text-amber-400" title="Warnings">
                  {'\u{1F7E1}'} {findingsCount.warnings}
                </span>
              )}
              {findingsCount.suggestions > 0 && (
                <span className="text-blue-400" title="Suggestions">
                  {'\u{1F535}'} {findingsCount.suggestions}
                </span>
              )}
            </div>
          )}
          {isReviewing && !isFixing && (
            <button
              type="button"
              onClick={onStop}
              className="text-xs px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
            >
              Stop
            </button>
          )}
          {isFixing && (
            <div className="flex items-center gap-1.5 text-xs text-blue-400">
              <Loader2 size={12} className="animate-spin" />
              <span>Fixing...</span>
            </div>
          )}
          {result && !isFixing && (
            <div className="flex items-center gap-1">
              {findingsCount.blocking > 0 && (
                <button
                  type="button"
                  onClick={onFixBlocking}
                  className="text-xs px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  Fix Blocking
                </button>
              )}
              <button
                type="button"
                onClick={onFixAll}
                className="text-xs px-2 py-1 rounded border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors"
              >
                Fix All
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isReviewing && progress && (
        <div className="px-4 py-2">
          <div className="relative h-1.5 bg-github-bg-tertiary rounded-full overflow-hidden">
            <div
              className="absolute top-0 left-0 h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${progress.overallProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Agent list */}
      {isReviewing && progress && progress.agents.length > 0 && (
        <div className="px-4 py-2 flex flex-wrap gap-x-3 gap-y-1">
          {progress.agents.map((agent) => (
            <div
              key={agent.name}
              className="flex items-center gap-1 text-xs text-github-text-secondary"
            >
              <AgentStatusIcon status={agent.status} />
              <span className={agent.status === 'running' ? 'text-github-text-primary' : ''}>
                {agent.displayName}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs">
            <span className="font-medium text-github-text-primary">Score: {result.score}/100</span>
            <span className={verdictLabels[result.verdict]?.color ?? 'text-github-text-secondary'}>
              {verdictLabels[result.verdict]?.label ?? result.verdict}
            </span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-2 flex items-center gap-2 text-xs text-red-400">
          <AlertTriangle size={12} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

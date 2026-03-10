import { type DiffComment, type FindingSeverity } from '../types/diff.js';

interface PostInlineCommentAction {
  type: 'POST_INLINE_COMMENT';
  filePath: string;
  line: number;
  body: string;
}

interface ReviewContextAction {
  type: string;
  filePath?: string;
  line?: number;
  body?: string;
}

interface ReviewContextResult {
  blocking: number;
  warnings: number;
  suggestions: number;
  score: number;
  verdict: 'ready_to_merge' | 'needs_fixes' | 'needs_discussion';
  findings?: Array<{
    severity: FindingSeverity;
    description: string;
    file?: string;
    line?: number;
  }>;
}

interface ReviewContext {
  actions: ReviewContextAction[];
  result?: ReviewContextResult;
}

function parseSeverityFromBody(body: string): FindingSeverity {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('\u{1F534}') || trimmed.startsWith(':red_circle:')) return 'blocking';
  if (trimmed.startsWith('\u{1F7E1}') || trimmed.startsWith(':yellow_circle:')) return 'warning';
  if (trimmed.startsWith('\u{1F535}') || trimmed.startsWith(':blue_circle:')) return 'suggestion';
  return 'suggestion';
}

function isInlineComment(action: ReviewContextAction): action is PostInlineCommentAction {
  return (
    action.type === 'POST_INLINE_COMMENT' &&
    typeof action.filePath === 'string' &&
    typeof action.line === 'number'
  );
}

export function reviewContextToDiffComments(context: ReviewContext): DiffComment[] {
  const comments: DiffComment[] = [];

  for (const action of context.actions) {
    if (!isInlineComment(action)) continue;

    const now = new Date().toISOString();
    comments.push({
      id: `ai-${action.filePath}-${action.line}-${comments.length}`,
      filePath: action.filePath,
      body: action.body,
      createdAt: now,
      updatedAt: now,
      position: {
        side: 'new',
        line: action.line,
      },
      severity: parseSeverityFromBody(action.body),
      source: 'ai-review',
      status: 'pending',
    });
  }

  return comments;
}

export function resultToSummaryComment(result: ReviewContextResult): DiffComment {
  const verdictLabels: Record<string, string> = {
    ready_to_merge: 'Ready to merge',
    needs_fixes: 'Needs fixes',
    needs_discussion: 'Needs discussion',
  };

  const now = new Date().toISOString();
  const body = [
    `## AI Review Summary`,
    '',
    `**Score**: ${result.score}/100`,
    `**Verdict**: ${verdictLabels[result.verdict] ?? result.verdict}`,
    '',
    `| Blocking | Warnings | Suggestions |`,
    `|----------|----------|-------------|`,
    `| ${result.blocking} | ${result.warnings} | ${result.suggestions} |`,
  ].join('\n');

  return {
    id: `ai-summary-${Date.now()}`,
    filePath: '__review_summary__',
    body,
    createdAt: now,
    updatedAt: now,
    position: { side: 'new', line: 0 },
    severity: result.blocking > 0 ? 'blocking' : result.warnings > 0 ? 'warning' : 'suggestion',
    source: 'ai-review',
    status: 'pending',
  };
}

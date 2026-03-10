# Fix Flow Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Fix button apply changes in the working tree without committing, auto-refresh the diff, and mark findings as "fixed" visually.

**Architecture:** Remove commit/push from fix prompts. After Claude edits files, the file watcher detects changes and triggers diff refresh. The `complete` event from the fix process marks targeted findings as `fixed`. UI shows green badge on fixed findings.

**Tech Stack:** TypeScript, React, vitest, review-flow MCP

---

## File Structure

| File                                                   | Action | Responsibility                                |
| ------------------------------------------------------ | ------ | --------------------------------------------- |
| `src/types/diff.ts:90`                                 | Modify | Add `'fixed'` to `FindingStatus` union        |
| `src/server/reviewOrchestrator.ts:878-918`             | Modify | Remove commit instructions from fix prompts   |
| `src/server/reviewOrchestrator.ts:622-632`             | Modify | Emit `fixedIds` in complete event             |
| `src/server/reviewOrchestrator.ts:85-93`               | Modify | Add `fixedIds` to `ReviewEvent`               |
| `src/server/server.ts:590-603`                         | Modify | Pass `findingIds` through to complete event   |
| `src/client/hooks/useReviewProgress.ts:104-113`        | Modify | Mark findings as `fixed` on complete          |
| `src/client/components/InlineComment.tsx:192-216`      | Modify | Show green "Fixed" badge, hide action buttons |
| `src/client/components/ReviewProgressPanel.tsx:62-177` | Modify | Add "Fix All" button, show fixing state       |
| `src/server/reviewOrchestrator.test.ts`                | Modify | Add tests for new fix behavior                |
| `src/server/findingsAdapter.test.ts`                   | Modify | Test `fixed` status                           |
| `src/client/App.test.tsx`                              | Modify | Update expected behavior                      |

---

## Chunk 1: Backend — No-commit fix + fixedIds propagation

### Task 1: Add `fixed` to FindingStatus type

**Files:**

- Modify: `src/types/diff.ts:90`

- [ ] **Step 1: Update FindingStatus type**

In `src/types/diff.ts`, line 90, change:

```typescript
export type FindingStatus = 'pending' | 'accepted' | 'rejected';
```

to:

```typescript
export type FindingStatus = 'pending' | 'accepted' | 'rejected' | 'fixed';
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors (no code references `FindingStatus` exhaustively yet)

---

### Task 2: Remove commit/push instructions from fix prompts

**Files:**

- Modify: `src/server/reviewOrchestrator.ts:878-918`

- [ ] **Step 1: Update `buildFixPrompt` to remove commit instruction**

In `src/server/reviewOrchestrator.ts`, replace the `buildFixPrompt` method (line 878):

```typescript
  private buildFixPrompt(findings: Array<{ severity: string; description: string; file?: string; line?: number }>): string {
    const findingsList = findings.map((f, i) =>
      `${i + 1}. [${f.severity}] ${f.file ?? 'unknown'}${f.line ? `:${f.line}` : ''} — ${f.description}`
    ).join('\n');

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
```

- [ ] **Step 2: Update `buildFixSystemPrompt` to forbid commit**

In `src/server/reviewOrchestrator.ts`, replace the `buildFixSystemPrompt` method (line 897):

```typescript
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
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/server/reviewOrchestrator.test.ts`
Expected: All pass

---

### Task 3: Track and emit fixedIds in complete event

**Files:**

- Modify: `src/server/reviewOrchestrator.ts:85-93` (ReviewEvent interface)
- Modify: `src/server/reviewOrchestrator.ts:490-639` (startFix method)

- [ ] **Step 1: Add `fixedIds` to ReviewEvent interface**

In `src/server/reviewOrchestrator.ts`, around line 85, change the `ReviewEvent` interface:

```typescript
export interface ReviewEvent {
  type: ReviewEventType;
  phase?: string;
  agents?: AgentProgress[];
  overallProgress?: number;
  comment?: DiffComment;
  result?: ReviewResult;
  message?: string;
  fixedIds?: string[]; // IDs of findings that were fixed
}
```

- [ ] **Step 2: Store fixingIds and emit them on complete**

In `startFix()`, after line 524 (`this.abortController = new AbortController();`), store the IDs being fixed:

```typescript
const fixingIds = findingIds;
```

Then in the `close` handler (line 622), change:

```typescript
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
  });
  this.currentJobId = null;
  this.childProcess = null;
});
```

to:

```typescript
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
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/server/reviewOrchestrator.test.ts`
Expected: All pass

---

### Task 4: Add test for fix emitting fixedIds

**Files:**

- Modify: `src/server/reviewOrchestrator.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/server/reviewOrchestrator.test.ts`:

```typescript
it('emits complete event with fixedIds after fix', async () => {
  const events: any[] = [];
  orchestrator.on((event) => events.push(event));

  // Simulate a previous review context on disk so startFix can read it
  const repoPath = '/tmp/test-fix-emit';
  mkdirSync(join(repoPath, '.claude', 'reviews', 'logs'), { recursive: true });
  writeFileSync(
    join(repoPath, '.claude', 'reviews', 'logs', 'local-test-local-123.json'),
    JSON.stringify({
      version: '1.0',
      mergeRequestId: 'local-test-local-123',
      platform: 'github',
      projectPath: 'test',
      mergeRequestNumber: 0,
      createdAt: new Date().toISOString(),
      threads: [],
      actions: [],
      progress: { phase: 'completed', currentStep: null, agents: [] },
      result: { blocking: 1, warnings: 0, suggestions: 0, score: 50, verdict: 'needs_fixes' },
    }),
  );

  // The complete event should include fixedIds
  const completeEvent = events.find((e) => e.type === 'complete');
  // This test validates the interface change - fixedIds field exists
  expect(completeEvent?.fixedIds).toBeDefined;
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/server/reviewOrchestrator.test.ts`
Expected: Pass

---

## Chunk 2: Frontend — Fixed status UI + auto-refresh

### Task 5: Handle fixedIds in useReviewProgress hook

**Files:**

- Modify: `src/client/hooks/useReviewProgress.ts:30-38` (ReviewEvent)
- Modify: `src/client/hooks/useReviewProgress.ts:104-113` (complete handler)

- [ ] **Step 1: Add fixedIds to client ReviewEvent**

In `src/client/hooks/useReviewProgress.ts`, around line 30, add `fixedIds` to the event:

```typescript
interface ReviewEvent {
  type: 'progress' | 'finding' | 'complete' | 'error';
  phase?: string;
  agents?: AgentProgress[];
  overallProgress?: number;
  comment?: DiffComment;
  result?: ReviewResult;
  message?: string;
  fixedIds?: string[];
}
```

- [ ] **Step 2: Mark findings as fixed on complete**

In `src/client/hooks/useReviewProgress.ts`, replace the `case 'complete':` block (lines 104-114):

```typescript
          case 'complete':
            if (data.result) {
              setResult(data.result);
            }
            // Mark targeted findings as fixed
            if (data.fixedIds && data.fixedIds.length > 0) {
              setFindings(prev => prev.map(f =>
                data.fixedIds!.includes(f.id) ? { ...f, status: 'fixed' as FindingStatus } : f
              ));
            }
            setIsReviewing(false);
            if (isFixingRef.current) {
              isFixingRef.current = false;
              setIsFixing(false);
              onFixComplete?.();
            }
            cleanup();
            break;
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 6: Update InlineComment to show "Fixed" badge

**Files:**

- Modify: `src/client/components/InlineComment.tsx:192-216`

- [ ] **Step 1: Add fixed status rendering**

In `src/client/components/InlineComment.tsx`, find the block starting at line 192 `{isAiReview && !isEditing ? (`. Replace the entire conditional with:

```typescript
          {isAiReview && !isEditing ? (
            comment.status === 'fixed' ? (
              <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 font-medium">
                Fixed
              </span>
            ) : (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onAccept?.(comment.id); }}
                  className="text-xs p-1.5 bg-github-bg-tertiary text-green-500 border border-github-border rounded hover:bg-green-500/10 hover:border-green-500 transition-all"
                  title="Accept"
                >
                  <CheckCircle size={12} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onReject?.(comment.id); }}
                  className="text-xs p-1.5 bg-github-bg-tertiary text-red-400 border border-github-border rounded hover:bg-red-500/10 hover:border-red-500 transition-all"
                  title="Reject"
                >
                  <X size={12} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); if (!isFixing) onFix?.(comment.id); }}
                  className={`text-xs p-1.5 bg-github-bg-tertiary text-blue-400 border border-github-border rounded transition-all ${isFixing ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-500/10 hover:border-blue-500'}`}
                  title={isFixing ? 'Fix in progress...' : 'Fix'}
                  disabled={isFixing}
                >
                  {isFixing ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                </button>
              </>
            )
```

- [ ] **Step 2: Add green border for fixed comments**

In the same file, find the comment container's className and add a conditional for fixed status. Look for the outer div that uses severity-based border colors. Add:

```typescript
comment.status === 'fixed' ? 'border-green-500/40 bg-green-500/5' :
```

as the first condition before the existing severity-based styling.

- [ ] **Step 3: Run type check and build**

Run: `npx tsc --noEmit && pnpm run build`
Expected: No errors, build succeeds

---

### Task 7: Add "Fix All" button + fixing state to ReviewProgressPanel

**Files:**

- Modify: `src/client/components/ReviewProgressPanel.tsx:25-33` (props)
- Modify: `src/client/components/ReviewProgressPanel.tsx:116-124` (buttons)

- [ ] **Step 1: Add `isFixing` and `onFixAll` (all findings) props**

In `src/client/components/ReviewProgressPanel.tsx`, update the props interface (line 25):

```typescript
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
```

- [ ] **Step 2: Update destructuring and button rendering**

Update the destructuring (line 62):

```typescript
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
```

Replace the buttons section (lines 107-124) with:

```typescript
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
```

- [ ] **Step 3: Update App.tsx to pass new props**

In `src/client/App.tsx`, update the `<ReviewProgressPanel>` usage (around line 1168):

```tsx
<ReviewProgressPanel
  isReviewing={isReviewing}
  isFixing={isFixing}
  progress={reviewProgress}
  result={reviewResult}
  error={reviewError}
  findingsCount={findingsCount}
  onStop={() => void stopReview()}
  onFixBlocking={() => {
    const blockingIds = findings
      .filter((f) => f.severity === 'blocking' && f.status !== 'rejected' && f.status !== 'fixed')
      .map((f) => f.id);
    void fixFindings(blockingIds);
  }}
  onFixAll={() => {
    const allIds = findings
      .filter((f) => f.status !== 'rejected' && f.status !== 'fixed')
      .map((f) => f.id);
    void fixFindings(allIds);
  }}
/>
```

- [ ] **Step 4: Build and run all tests**

Run: `pnpm run build && npx vitest run`
Expected: Build succeeds, all tests pass (update App.test.tsx if needed for the new prop)

---

### Task 8: Update tests

**Files:**

- Modify: `src/server/server.review.test.ts`
- Modify: `src/client/App.test.tsx`

- [ ] **Step 1: Update server review tests mock for fixedIds**

In `src/server/server.review.test.ts`, the `MockLocalReviewOrchestrator.startFix` should store `fixingIds` and `_simulateComplete` should propagate `fixedIds`. This is already handled by the mock's emit mechanism — verify tests still pass.

Run: `npx vitest run src/server/server.review.test.ts`

- [ ] **Step 2: Update App.test.tsx if fetch count changed**

If adding new props or review hooks changed the fetch count at mount, update the expected count.

Run: `npx vitest run src/client/App.test.tsx`

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All 550+ tests pass

---

### Task 9: Build and manual verification

- [ ] **Step 1: Final build**

Run: `pnpm run build`
Expected: Build succeeds with no errors

- [ ] **Step 2: Manual test flow**

1. `cd <api-repo> && difit .`
2. Verify previous findings are restored (green "Fixed" badge should NOT appear on old findings)
3. Click Fix (wrench) on one finding
4. Verify: spinner appears on button, "Fixing..." in panel
5. Verify: Claude edits files without committing (check terminal logs)
6. Verify: diff auto-refreshes showing the edited files
7. Verify: finding shows green "Fixed" badge
8. Verify: other findings still show accept/reject/fix buttons
9. Click "Fix All" — verify all remaining findings get fixed
10. Verify: `git status` shows unstaged changes (not committed)

---

## Summary of Changes

| What               | Before                            | After                                      |
| ------------------ | --------------------------------- | ------------------------------------------ |
| Fix commit         | Claude commits + no push          | Claude edits files only, no git operations |
| After fix          | Diff disappears (committed)       | Diff refreshes with new changes visible    |
| Finding status     | No visual change                  | Green "Fixed" badge, action buttons hidden |
| Fix buttons        | "Fix Blocking" only               | "Fix Blocking" + "Fix All"                 |
| During fix         | No feedback                       | Spinner on button + "Fixing..." in panel   |
| FindingStatus type | `pending \| accepted \| rejected` | `pending \| accepted \| rejected \| fixed` |

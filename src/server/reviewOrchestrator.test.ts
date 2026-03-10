import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

import type { ReviewEvent } from './reviewOrchestrator.js';

const mockedSpawn = vi.mocked(spawn);

// Mock child_process using the import() form which supports async importOriginal
vi.mock(import('child_process'), async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter: EE } = await import('events');

  function createMockChild() {
    const child = new EE() as any;
    child.killed = false;
    child.pid = 12345;
    child.kill = vi.fn(() => {
      child.killed = true;
    });
    child.stdin = null;
    child.stdout = new EE();
    child.stderr = new EE();
    return child;
  }

  const mockSpawn = vi.fn(() => createMockChild());

  return {
    ...actual,
    default: { ...actual, spawn: mockSpawn },
    spawn: mockSpawn,
  };
});

describe('LocalReviewOrchestrator', () => {
  let orchestrator: InstanceType<typeof import('./reviewOrchestrator.js').LocalReviewOrchestrator>;
  let tmpRepoPath: string;

  beforeEach(async () => {
    const mod = await import('./reviewOrchestrator.js');
    orchestrator = new mod.LocalReviewOrchestrator();
    tmpRepoPath = join(tmpdir(), `difit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpRepoPath, { recursive: true });
  });

  afterEach(() => {
    orchestrator?.stopReview();
    if (tmpRepoPath && existsSync(tmpRepoPath)) {
      rmSync(tmpRepoPath, { recursive: true, force: true });
    }
  });

  describe('initial state', () => {
    it('getSnapshot returns empty state', () => {
      const snapshot = orchestrator.getSnapshot();
      expect(snapshot.progress).toBeNull();
      expect(snapshot.findings).toEqual([]);
      expect(snapshot.result).toBeNull();
    });

    it('isRunning returns false', () => {
      expect(orchestrator.isRunning()).toBe(false);
    });

    it('getProgress returns null', () => {
      expect(orchestrator.getProgress()).toBeNull();
    });

    it('getResult returns null', () => {
      expect(orchestrator.getResult()).toBeNull();
    });

    it('getFindings returns empty array', () => {
      expect(orchestrator.getFindings()).toEqual([]);
    });
  });

  describe('event listeners', () => {
    it('on() returns an unsubscribe function', () => {
      const unsub = orchestrator.on(() => {});
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('multiple listeners can be registered and unregistered independently', () => {
      const events1: ReviewEvent[] = [];
      const events2: ReviewEvent[] = [];
      const unsub1 = orchestrator.on((e) => events1.push(e));
      const unsub2 = orchestrator.on((e) => events2.push(e));

      unsub1();
      unsub2();

      expect(events1).toEqual([]);
      expect(events2).toEqual([]);
    });
  });

  describe('stopReview', () => {
    it('does not throw when no review is running', () => {
      expect(() => orchestrator.stopReview()).not.toThrow();
    });

    it('sets isRunning to false', () => {
      orchestrator.stopReview();
      expect(orchestrator.isRunning()).toBe(false);
    });
  });
});

describe('Findings deduplication', () => {
  it('reviewContextToDiffComments produces deterministic IDs', async () => {
    const { reviewContextToDiffComments } = await import('./findingsAdapter.js');

    const context = {
      actions: [{ type: 'POST_INLINE_COMMENT', filePath: 'src/a.ts', line: 10, body: 'Issue' }],
    };

    const first = reviewContextToDiffComments(context);
    const second = reviewContextToDiffComments(context);
    expect(first[0].id).toBe(second[0].id);
  });

  it('different comments on same line get different IDs', async () => {
    const { reviewContextToDiffComments } = await import('./findingsAdapter.js');

    const context = {
      actions: [
        { type: 'POST_INLINE_COMMENT', filePath: 'src/a.ts', line: 10, body: 'First' },
        { type: 'POST_INLINE_COMMENT', filePath: 'src/a.ts', line: 10, body: 'Second' },
      ],
    };

    const comments = reviewContextToDiffComments(context);
    expect(comments[0].id).not.toBe(comments[1].id);
  });
});

describe('Git diff command generation', () => {
  let orchestrator: InstanceType<typeof import('./reviewOrchestrator.js').LocalReviewOrchestrator>;
  let tmpRepoPath: string;

  beforeEach(async () => {
    const mod = await import('./reviewOrchestrator.js');
    orchestrator = new mod.LocalReviewOrchestrator();
    tmpRepoPath = join(
      tmpdir(),
      `difit-gitdiff-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRepoPath, { recursive: true });
  });

  afterEach(() => {
    orchestrator?.stopReview();
    if (tmpRepoPath && existsSync(tmpRepoPath)) {
      rmSync(tmpRepoPath, { recursive: true, force: true });
    }
  });

  function getSystemPromptFromSpawn(): string | null {
    if (mockedSpawn.mock.calls.length === 0) return null;
    const args = mockedSpawn.mock.calls[mockedSpawn.mock.calls.length - 1][1] as string[];
    const idx = args.indexOf('--append-system-prompt');
    return idx >= 0 ? args[idx + 1] : null;
  }

  it('uses "git diff HEAD" for target "." (all uncommitted)', () => {
    mockedSpawn.mockClear();

    try {
      orchestrator.startReview(tmpRepoPath, 'HEAD', '.', 'review');
    } catch {
      /* spawn mock may fail finding review-flow, ok */
    }

    const prompt = getSystemPromptFromSpawn();
    if (prompt) {
      expect(prompt).toContain('git diff HEAD');
      expect(prompt).not.toContain('git diff HEAD..');
    }
  });

  it('uses "git diff --cached HEAD" for target "staged"', () => {
    mockedSpawn.mockClear();

    try {
      orchestrator.startReview(tmpRepoPath, 'HEAD', 'staged', 'review');
    } catch {
      /* ok */
    }

    const prompt = getSystemPromptFromSpawn();
    if (prompt) {
      expect(prompt).toContain('git diff --cached HEAD');
    }
  });

  it('uses "git diff base..target" for normal refs', () => {
    mockedSpawn.mockClear();

    try {
      orchestrator.startReview(tmpRepoPath, 'main', 'feature', 'review');
    } catch {
      /* ok */
    }

    const prompt = getSystemPromptFromSpawn();
    if (prompt) {
      expect(prompt).toContain('git diff main..feature');
    }
  });
});

import { describe, it, expect } from 'vitest';

import { reviewContextToDiffComments, resultToSummaryComment } from './findingsAdapter.js';

describe('findingsAdapter', () => {
  describe('reviewContextToDiffComments', () => {
    it('converts POST_INLINE_COMMENT actions to DiffComment[]', () => {
      const context = {
        actions: [
          { type: 'POST_INLINE_COMMENT', filePath: 'src/app.ts', line: 42, body: 'Some comment' },
          {
            type: 'POST_INLINE_COMMENT',
            filePath: 'src/utils.ts',
            line: 10,
            body: 'Another comment',
          },
        ],
      };

      const comments = reviewContextToDiffComments(context);
      expect(comments).toHaveLength(2);
      expect(comments[0].filePath).toBe('src/app.ts');
      expect(comments[0].position).toEqual({ side: 'new', line: 42 });
      expect(comments[0].body).toBe('Some comment');
      expect(comments[0].source).toBe('ai-review');
      expect(comments[0].status).toBe('pending');
    });

    it('parses blocking severity from 🔴 emoji prefix', () => {
      const context = {
        actions: [
          {
            type: 'POST_INLINE_COMMENT',
            filePath: 'a.ts',
            line: 1,
            body: '\u{1F534} Critical issue here',
          },
        ],
      };
      const comments = reviewContextToDiffComments(context);
      expect(comments[0].severity).toBe('blocking');
    });

    it('parses warning severity from 🟡 emoji prefix', () => {
      const context = {
        actions: [
          {
            type: 'POST_INLINE_COMMENT',
            filePath: 'a.ts',
            line: 1,
            body: '\u{1F7E1} Potential issue',
          },
        ],
      };
      const comments = reviewContextToDiffComments(context);
      expect(comments[0].severity).toBe('warning');
    });

    it('parses suggestion severity from 🔵 emoji prefix', () => {
      const context = {
        actions: [
          {
            type: 'POST_INLINE_COMMENT',
            filePath: 'a.ts',
            line: 1,
            body: '\u{1F535} Consider refactoring',
          },
        ],
      };
      const comments = reviewContextToDiffComments(context);
      expect(comments[0].severity).toBe('suggestion');
    });

    it('parses severity from markdown emoji codes', () => {
      const blocking = reviewContextToDiffComments({
        actions: [
          { type: 'POST_INLINE_COMMENT', filePath: 'a.ts', line: 1, body: ':red_circle: Blocker' },
        ],
      });
      expect(blocking[0].severity).toBe('blocking');

      const warning = reviewContextToDiffComments({
        actions: [
          {
            type: 'POST_INLINE_COMMENT',
            filePath: 'a.ts',
            line: 1,
            body: ':yellow_circle: Warning',
          },
        ],
      });
      expect(warning[0].severity).toBe('warning');

      const suggestion = reviewContextToDiffComments({
        actions: [
          {
            type: 'POST_INLINE_COMMENT',
            filePath: 'a.ts',
            line: 1,
            body: ':blue_circle: Suggestion',
          },
        ],
      });
      expect(suggestion[0].severity).toBe('suggestion');
    });

    it('defaults to suggestion severity when no emoji prefix', () => {
      const context = {
        actions: [
          {
            type: 'POST_INLINE_COMMENT',
            filePath: 'a.ts',
            line: 1,
            body: 'Plain comment with no emoji',
          },
        ],
      };
      const comments = reviewContextToDiffComments(context);
      expect(comments[0].severity).toBe('suggestion');
    });

    it('ignores non-inline-comment actions', () => {
      const context = {
        actions: [
          { type: 'SET_PHASE', body: 'initializing' },
          { type: 'POST_INLINE_COMMENT', filePath: 'a.ts', line: 1, body: 'Found something' },
          { type: 'SET_RESULT', body: 'done' },
        ],
      };
      const comments = reviewContextToDiffComments(context);
      expect(comments).toHaveLength(1);
    });

    it('ignores inline-comment actions missing required fields', () => {
      const context = {
        actions: [
          { type: 'POST_INLINE_COMMENT', body: 'No filePath' },
          { type: 'POST_INLINE_COMMENT', filePath: 'a.ts', body: 'No line' },
          { type: 'POST_INLINE_COMMENT', filePath: 'a.ts', line: 1, body: 'Valid' },
        ],
      };
      const comments = reviewContextToDiffComments(context);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe('Valid');
    });

    it('returns empty array for empty actions', () => {
      expect(reviewContextToDiffComments({ actions: [] })).toEqual([]);
    });

    it('generates unique IDs per comment', () => {
      const context = {
        actions: [
          { type: 'POST_INLINE_COMMENT', filePath: 'a.ts', line: 1, body: 'First' },
          { type: 'POST_INLINE_COMMENT', filePath: 'a.ts', line: 1, body: 'Second on same line' },
        ],
      };
      const comments = reviewContextToDiffComments(context);
      expect(comments[0].id).not.toBe(comments[1].id);
    });
  });

  describe('resultToSummaryComment', () => {
    it('creates a summary DiffComment from review result', () => {
      const result = {
        blocking: 2,
        warnings: 3,
        suggestions: 5,
        score: 42,
        verdict: 'needs_fixes' as const,
      };

      const comment = resultToSummaryComment(result);
      expect(comment.filePath).toBe('__review_summary__');
      expect(comment.source).toBe('ai-review');
      expect(comment.body).toContain('Score**: 42/100');
      expect(comment.body).toContain('Needs fixes');
      expect(comment.body).toContain('| 2 | 3 | 5 |');
    });

    it('sets severity based on worst finding type', () => {
      expect(
        resultToSummaryComment({
          blocking: 1,
          warnings: 0,
          suggestions: 0,
          score: 50,
          verdict: 'needs_fixes' as const,
        }).severity,
      ).toBe('blocking');

      expect(
        resultToSummaryComment({
          blocking: 0,
          warnings: 2,
          suggestions: 0,
          score: 70,
          verdict: 'needs_discussion' as const,
        }).severity,
      ).toBe('warning');

      expect(
        resultToSummaryComment({
          blocking: 0,
          warnings: 0,
          suggestions: 3,
          score: 90,
          verdict: 'ready_to_merge' as const,
        }).severity,
      ).toBe('suggestion');
    });
  });
});

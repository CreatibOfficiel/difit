import { Check, Edit2, CheckCircle, X, Wrench, Loader2 } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { type Comment, type FindingSeverity } from '../../types/diff';
import { useReviewActions } from '../contexts/ReviewActionsContext';

import { CommentBodyRenderer, hasSuggestionInBody } from './CommentBodyRenderer';
import type { AppearanceSettings } from './SettingsModal';
import { SuggestionTemplateButton } from './SuggestionTemplateButton';

type CommentEditMode = 'edit' | 'preview';

interface InlineCommentProps {
  comment: Comment;
  onGeneratePrompt: (comment: Comment) => string;
  onRemoveComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, newBody: string) => void;
  onClick?: (e: React.MouseEvent) => void;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
}

const severityConfig: Record<
  FindingSeverity,
  { label: string; emoji: string; borderClass: string; badgeClass: string }
> = {
  blocking: {
    label: 'Blocking',
    emoji: '\u{1F534}',
    borderClass: 'border-l-red-500',
    badgeClass: 'bg-red-500/10 text-red-400 border-red-500/30',
  },
  warning: {
    label: 'Warning',
    emoji: '\u{1F7E1}',
    borderClass: 'border-l-amber-400',
    badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  },
  suggestion: {
    label: 'Suggestion',
    emoji: '\u{1F535}',
    borderClass: 'border-l-blue-400',
    badgeClass: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  },
};

export function InlineComment({
  comment,
  onGeneratePrompt,
  onRemoveComment,
  onUpdateComment,
  onClick,
  syntaxTheme,
}: InlineCommentProps) {
  const {
    acceptFinding: onAccept,
    rejectFinding: onReject,
    fixFinding: onFix,
    isFixing,
  } = useReviewActions();
  const [isCopied, setIsCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedBody, setEditedBody] = useState(comment.body);
  const [editMode, setEditMode] = useState<CommentEditMode>('edit');
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const hasSuggestionInEditedBody = hasSuggestionInBody(editedBody);
  const effectiveEditMode: CommentEditMode = hasSuggestionInEditedBody ? editMode : 'edit';

  const handleCopyPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const prompt = onGeneratePrompt(comment);
      await navigator.clipboard.writeText(prompt);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy prompt:', error);
    }
  };

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
    setEditMode('edit');
    setEditedBody(comment.body);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditMode('edit');
    setEditedBody(comment.body);
  };

  const handleSaveEdit = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (editedBody.trim() !== comment.body) {
      onUpdateComment(comment.id, editedBody.trim());
    }
    setIsEditing(false);
    setEditMode('edit');
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemoveComment(comment.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  // Keyboard shortcuts for editing
  useHotkeys(
    'escape',
    () => {
      if (isEditing) {
        handleCancelEdit();
      }
    },
    { enableOnFormTags: ['textarea'], enabled: isEditing },
    [isEditing],
  );

  useHotkeys(
    'mod+enter',
    () => {
      if (isEditing) {
        handleSaveEdit();
      }
    },
    { enableOnFormTags: ['textarea'], enabled: isEditing },
    [isEditing, editedBody, comment.body],
  );

  const isAiReview = comment.source === 'ai-review';
  const severity = comment.severity ?? 'suggestion';
  const status = comment.status ?? 'pending';
  const sevConfig = isAiReview ? severityConfig[severity] : null;

  // Collapsed state for rejected AI comments
  const isRejected = isAiReview && status === 'rejected';
  const isAccepted = isAiReview && status === 'accepted';

  if (isRejected) {
    return (
      <div
        id={`comment-${comment.id}`}
        className="p-2 bg-github-bg-tertiary border border-github-border rounded-md border-l-4 border-l-gray-500 opacity-50 transition-all"
      >
        <div className="flex items-center justify-between text-xs text-github-text-muted">
          <span>Rejected finding</span>
          <button
            type="button"
            onClick={() => onAccept?.(comment.id)}
            className="text-xs px-2 py-0.5 rounded border border-github-border text-github-text-secondary hover:text-github-text-primary transition-colors"
          >
            Undo
          </button>
        </div>
      </div>
    );
  }

  const borderClass = isAiReview
    ? (sevConfig?.borderClass ?? 'border-l-blue-400')
    : 'border-l-yellow-400';
  const bgClass = isAccepted ? 'bg-green-500/5' : 'bg-github-bg-tertiary';
  const borderColor = isAiReview ? 'border-blue-600/30' : 'border-yellow-600/50';

  return (
    <div
      id={`comment-${comment.id}`}
      className={`p-3 ${bgClass} border ${borderColor} rounded-md border-l-4 ${borderClass} shadow-sm transition-all ${
        onClick ? 'hover:shadow-md cursor-pointer' : ''
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2 gap-3">
        <div className="flex items-center gap-2 text-xs text-github-text-secondary flex-1 min-w-0">
          {isAiReview && sevConfig && (
            <span
              className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${sevConfig.badgeClass}`}
            >
              {sevConfig.emoji} {sevConfig.label}
            </span>
          )}
          {isAccepted && (
            <span className="px-1.5 py-0.5 rounded border text-[10px] font-medium bg-green-500/10 text-green-400 border-green-500/30">
              Accepted
            </span>
          )}
          {comment.agentName && (
            <span className="text-[10px] text-github-text-muted">{comment.agentName}</span>
          )}
          <span
            className="font-mono px-1 py-0.5 rounded overflow-hidden text-ellipsis whitespace-nowrap"
            style={{
              backgroundColor: 'var(--color-yellow-path-bg)',
              color: 'var(--color-yellow-path-text)',
            }}
          >
            {comment.file}:
            {Array.isArray(comment.line) ? `${comment.line[0]}-${comment.line[1]}` : comment.line}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isAiReview && !isEditing ? (
            comment.status === 'fixed' ? (
              <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 font-medium">
                Fixed
              </span>
            ) : (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAccept?.(comment.id);
                  }}
                  className="text-xs p-1.5 bg-github-bg-tertiary text-green-500 border border-github-border rounded hover:bg-green-500/10 hover:border-green-500 transition-all"
                  title="Accept"
                >
                  <CheckCircle size={12} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onReject?.(comment.id);
                  }}
                  className="text-xs p-1.5 bg-github-bg-tertiary text-red-400 border border-github-border rounded hover:bg-red-500/10 hover:border-red-500 transition-all"
                  title="Reject"
                >
                  <X size={12} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isFixing) onFix?.(comment.id);
                  }}
                  className={`text-xs p-1.5 bg-github-bg-tertiary text-blue-400 border border-github-border rounded transition-all ${isFixing ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-500/10 hover:border-blue-500'}`}
                  title={isFixing ? 'Fix in progress...' : 'Fix'}
                  disabled={isFixing}
                >
                  {isFixing ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                </button>
              </>
            )
          ) : isEditing ? (
            hasSuggestionInEditedBody ? (
              <div
                className="flex items-center bg-github-bg-tertiary border border-github-border rounded p-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => setEditMode('edit')}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                    effectiveEditMode === 'edit'
                      ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                      : 'text-github-text-secondary hover:text-github-text-primary'
                  }`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setEditMode('preview')}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                    effectiveEditMode === 'preview'
                      ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                      : 'text-github-text-secondary hover:text-github-text-primary'
                  }`}
                >
                  Preview
                </button>
              </div>
            ) : (
              <div onClick={(e) => e.stopPropagation()}>
                <SuggestionTemplateButton
                  selectedCode={comment.codeContent}
                  value={editedBody}
                  onChange={setEditedBody}
                  textareaRef={editTextareaRef}
                />
              </div>
            )
          ) : (
            <>
              <button
                onClick={handleCopyPrompt}
                className="text-xs px-2 py-1 rounded transition-all whitespace-nowrap"
                style={{
                  backgroundColor: 'var(--color-yellow-btn-bg)',
                  color: 'var(--color-yellow-btn-text)',
                  border: '1px solid var(--color-yellow-btn-border)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-hover-bg)';
                  e.currentTarget.style.borderColor = 'var(--color-yellow-btn-hover-border)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-bg)';
                  e.currentTarget.style.borderColor = 'var(--color-yellow-btn-border)';
                }}
                title="Copy prompt for AI coding agent"
              >
                {isCopied ? 'Copied!' : 'Copy Prompt'}
              </button>
              <button
                onClick={handleStartEdit}
                className="text-xs p-1.5 bg-github-bg-tertiary text-github-text-secondary border border-github-border rounded hover:text-github-text-primary hover:bg-github-bg-primary transition-all"
                title="Edit"
              >
                <Edit2 size={12} />
              </button>
              <button
                onClick={handleRemove}
                className="text-xs p-1.5 bg-github-bg-tertiary text-green-600 border border-github-border rounded hover:bg-green-500/10 hover:border-green-600 transition-all"
                title="Resolve"
              >
                <Check size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      {!isEditing ? (
        <CommentBodyRenderer
          body={comment.body}
          originalCode={comment.codeContent}
          filename={comment.file}
          syntaxTheme={syntaxTheme}
        />
      ) : (
        <div>
          {hasSuggestionInEditedBody && effectiveEditMode === 'preview' ? (
            <CommentBodyRenderer
              body={editedBody}
              originalCode={comment.codeContent}
              filename={comment.file}
              syntaxTheme={syntaxTheme}
            />
          ) : (
            <>
              <textarea
                ref={editTextareaRef}
                value={editedBody}
                onChange={(e) => setEditedBody(e.target.value)}
                className="w-full text-github-text-primary text-sm leading-6 bg-github-bg-secondary border border-github-border rounded px-2 py-1 resize-none focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600/30"
                rows={Math.max(2, editedBody.split('\n').length)}
                placeholder="Edit your comment..."
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  // Stop propagation to prevent triggering parent keyboard handlers
                  e.stopPropagation();
                  handleKeyDown(e);
                }}
              />
            </>
          )}
          <div className="flex gap-2 justify-end mt-2">
            <button
              type="button"
              onClick={handleCancelEdit}
              className="text-xs px-3 py-1.5 bg-github-bg-tertiary text-github-text-primary border border-github-border rounded hover:opacity-80 transition-all"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveEdit}
              className="text-xs px-3 py-1.5 rounded transition-all disabled:opacity-50"
              style={{
                backgroundColor: 'var(--color-yellow-btn-bg)',
                color: 'var(--color-yellow-btn-text)',
                border: '1px solid var(--color-yellow-btn-border)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-hover-bg)';
                e.currentTarget.style.borderColor = 'var(--color-yellow-btn-hover-border)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-bg)';
                e.currentTarget.style.borderColor = 'var(--color-yellow-btn-border)';
              }}
              disabled={!editedBody.trim()}
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

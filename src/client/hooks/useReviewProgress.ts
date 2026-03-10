import { useState, useCallback, useRef, useEffect } from 'react';

import { type DiffComment, type FindingStatus } from '../../types/diff';

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

interface UseReviewProgressReturn {
  isReviewing: boolean;
  isFixing: boolean;
  progress: ReviewProgressData | null;
  findings: DiffComment[];
  result: ReviewResult | null;
  error: string | null;
  startReview: (skill?: string) => Promise<void>;
  stopReview: () => Promise<void>;
  acceptFinding: (id: string) => void;
  rejectFinding: (id: string) => void;
  fixFindings: (ids: string[]) => Promise<void>;
}

export function useReviewProgress(onFixComplete?: () => void): UseReviewProgressReturn {
  const [isReviewing, setIsReviewing] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [progress, setProgress] = useState<ReviewProgressData | null>(null);
  const [findings, setFindings] = useState<DiffComment[]>([]);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const isFixingRef = useRef(false);
  const isReviewingRef = useRef(false);
  const onFixCompleteRef = useRef(onFixComplete);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  useEffect(() => {
    isReviewingRef.current = isReviewing;
  }, [isReviewing]);

  useEffect(() => {
    onFixCompleteRef.current = onFixComplete;
  }, [onFixComplete]);

  const connectSSE = useCallback(() => {
    cleanup();

    const es = new EventSource('/api/review/progress');
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as ReviewEvent;

        switch (data.type) {
          case 'progress':
            setProgress({
              phase: data.phase ?? 'initializing',
              agents: data.agents ?? [],
              overallProgress: data.overallProgress ?? 0,
            });
            break;

          case 'finding': {
            const comment = data.comment;
            if (comment) {
              setFindings((prev) => {
                const exists = prev.some((f) => f.id === comment.id);
                if (exists) return prev;
                return [...prev, comment];
              });
            }
            break;
          }

          case 'complete':
            if (isFixingRef.current) {
              // Fix complete — mark findings as fixed, keep original review result
              if (data.fixedIds && data.fixedIds.length > 0) {
                setFindings((prev) =>
                  prev.map((f) =>
                    data.fixedIds?.includes(f.id) ? { ...f, status: 'fixed' as FindingStatus } : f,
                  ),
                );
              }
              isFixingRef.current = false;
              setIsFixing(false);
              setIsReviewing(false);
              onFixCompleteRef.current?.();
            } else {
              // Review complete — set the result
              if (data.result) {
                setResult(data.result);
              }
              setIsReviewing(false);
            }
            cleanup();
            break;

          case 'error':
            setError(data.message ?? 'Unknown error');
            setIsReviewing(false);
            cleanup();
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // SSE reconnects automatically, but if the review is done we clean up
      if (!isReviewingRef.current) {
        cleanup();
      }
    };
  }, [cleanup]);

  // Check if a review is already running or completed on mount
  // (e.g. started via --review CLI flag, or completed before UI loaded)
  const hasAutoConnected = useRef(false);
  useEffect(() => {
    let cancelled = false;

    interface StatusResponse {
      running: boolean;
      progress?: ReviewProgressData | null;
      findings?: DiffComment[];
      result?: ReviewResult | null;
    }

    fetch('/api/review/status')
      .then((res) => res.json() as Promise<StatusResponse>)
      .then((data) => {
        if (cancelled || hasAutoConnected.current) return;
        hasAutoConnected.current = true;

        if (data.running) {
          // Review in progress — connect SSE for live updates (it replays existing state)
          setIsReviewing(true);
          connectSSE();
        } else if (data.result) {
          // Review already completed — load results directly (no SSE needed)
          if (data.progress) setProgress(data.progress);
          if (data.findings) setFindings(data.findings);
          setResult(data.result);
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [connectSSE]);

  const startReview = useCallback(
    async (skill?: string) => {
      setIsReviewing(true);
      setFindings([]);
      setResult(null);
      setError(null);
      setProgress(null);

      try {
        const response = await fetch('/api/review/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skill }),
        });

        if (!response.ok) {
          const data = (await response.json()) as { error?: string };
          throw new Error(data.error ?? 'Failed to start review');
        }

        connectSSE();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start review');
        setIsReviewing(false);
      }
    },
    [connectSSE],
  );

  const stopReview = useCallback(async () => {
    try {
      await fetch('/api/review/stop', { method: 'POST' });
    } catch {
      // ignore
    }
    cleanup();
    setIsReviewing(false);
  }, [cleanup]);

  const acceptFinding = useCallback((id: string) => {
    setFindings((prev) =>
      prev.map((f) => (f.id === id ? { ...f, status: 'accepted' as FindingStatus } : f)),
    );
  }, []);

  const rejectFinding = useCallback((id: string) => {
    setFindings((prev) =>
      prev.map((f) => (f.id === id ? { ...f, status: 'rejected' as FindingStatus } : f)),
    );
  }, []);

  const fixFindings = useCallback(
    async (ids: string[]) => {
      try {
        setIsFixing(true);
        isFixingRef.current = true;
        setError(null);

        const response = await fetch('/api/review/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ findingIds: ids }),
        });

        if (!response.ok) {
          throw new Error('Failed to start fix');
        }

        setIsReviewing(true);
        connectSSE();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start fix');
        setIsFixing(false);
        isFixingRef.current = false;
      }
    },
    [connectSSE],
  );

  return {
    isReviewing,
    isFixing,
    progress,
    findings,
    result,
    error,
    startReview,
    stopReview,
    acceptFinding,
    rejectFinding,
    fixFindings,
  };
}

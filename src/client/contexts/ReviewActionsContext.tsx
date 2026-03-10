import { createContext, useContext } from 'react';

interface ReviewActionsContextValue {
  acceptFinding: (id: string) => void;
  rejectFinding: (id: string) => void;
  fixFinding: (id: string) => void;
  isFixing: boolean;
}

const noop = () => {};

export const ReviewActionsContext = createContext<ReviewActionsContextValue>({
  acceptFinding: noop,
  rejectFinding: noop,
  fixFinding: noop,
  isFixing: false,
});

export function useReviewActions(): ReviewActionsContextValue {
  return useContext(ReviewActionsContext);
}

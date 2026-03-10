import { createContext, useContext } from 'react';

interface ReviewActionsContextValue {
  acceptFinding: (id: string) => void;
  rejectFinding: (id: string) => void;
  fixFinding: (id: string) => void;
  isFixing: boolean;
  selectedIds: Set<string>;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
}

const noop = () => {};
const emptySet = new Set<string>();

export const ReviewActionsContext = createContext<ReviewActionsContextValue>({
  acceptFinding: noop,
  rejectFinding: noop,
  fixFinding: noop,
  isFixing: false,
  selectedIds: emptySet,
  toggleSelection: noop,
  clearSelection: noop,
});

export function useReviewActions(): ReviewActionsContextValue {
  return useContext(ReviewActionsContext);
}

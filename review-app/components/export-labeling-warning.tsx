'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { exportLabelingSummary } from '@/lib/export-labeling';
import type { Review } from '@/lib/review-types';

export function ExportLabelingWarning({
  reviews,
  open,
  onOpenChange,
  onConfirm,
}: {
  reviews: Review[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const counts = exportLabelingSummary(reviews);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Labeling is incomplete</AlertDialogTitle>
          <AlertDialogDescription>
            {counts.incompleteReviews} selected review
            {counts.incompleteReviews === 1 ? '' : 's'} still{' '}
            {counts.incompleteReviews === 1 ? 'has' : 'have'} unlabeled
            insights.
            {counts.pending > 0 && (
              <>
                {' '}
                {counts.pending} pending insight
                {counts.pending === 1 ? '' : 's'} will be treated as accepted in
                this export.
              </>
            )}
            {counts.needsReview > 0 && (
              <>
                {' '}
                {counts.needsReview} insight
                {counts.needsReview === 1 ? '' : 's'} with changed evidence will
                remain excluded until reviewed.
              </>
            )}{' '}
            Saved labels will stay unchanged. You can go back to finish labeling
            or export now.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep labeling</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Export anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

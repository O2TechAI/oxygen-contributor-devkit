import { useState } from 'react';
import { Info } from 'lucide-react';
import type { Review } from '@/lib/review-types';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

export function ReviewInfo({ review }: { review: Review }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Page information"
        title="Page information"
        onClick={() => setOpen(true)}
      >
        <Info />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Page information</SheetTitle>
            <SheetDescription>
              Source and generation details for this review.
            </SheetDescription>
          </SheetHeader>
          <dl className="space-y-4 px-4 text-sm [&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:break-all">
            <div>
              <dt>Project</dt>
              <dd>{review.projectName}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{review.sourcePath}</dd>
            </div>
            <div>
              <dt>Protocol</dt>
              <dd>Protocol v{review.protocolVersion}</dd>
            </div>
            <div>
              <dt>Stage</dt>
              <dd className="capitalize">{review.stage} stage</dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd className="capitalize">{review.privacyStatus}</dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>
                {review.provenance.hashVerified
                  ? 'Manifest hashes verified'
                  : 'Example data'}
              </dd>
            </div>
            {review.provenance.model && (
              <div>
                <dt>Model</dt>
                <dd>
                  {review.provenance.model}
                  {review.provenance.reasoningEffort
                    ? ` · ${review.provenance.reasoningEffort}`
                    : ''}
                </dd>
              </div>
            )}
            <div>
              <dt>Revision</dt>
              <dd>{review.revisionCount}</dd>
            </div>
          </dl>
        </SheetContent>
      </Sheet>
    </>
  );
}

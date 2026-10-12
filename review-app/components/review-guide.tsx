import { useEffect, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { hasWorkflowField, type Review } from '@/lib/review-types';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

const GUIDE_SEEN = 'oxygen-review-guide-seen-v1';

export function ReviewGuide({ review }: { review: Review }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setOpen(localStorage.getItem(GUIDE_SEEN) !== '1');
      } catch {
        setOpen(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function changeOpen(value: boolean) {
    setOpen(value);
    if (!value) {
      try {
        localStorage.setItem(GUIDE_SEEN, '1');
      } catch {
        /* Available again through Help if storage is disabled. */
      }
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Review help"
        title="Review help"
        onClick={() => changeOpen(true)}
      >
        <CircleHelp />
      </Button>
      <Sheet open={open} onOpenChange={changeOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>
              Your corrections are part of the contribution.
            </SheetTitle>
            <SheetDescription>
              Keep the useful method. Preserve what actually happened. Declining
              a weak card is useful too.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-5 px-4 text-sm leading-6">
            <a
              href="https://oxygen.o2tech.ai/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              Why contribute? ↗
            </a>
            <h3 className="font-medium">
              A quick check for a useful contribution
            </h3>
            <ol className="space-y-4">
              <li>
                <strong>1. Follow the turning point.</strong>
                <br />
                Read the summary and cited lines. Does the example preserve the
                request, correction, action, and actual result in order?
              </li>
              <li>
                <strong>2. Imagine using it again.</strong>
                <br />
                Is the trigger clear? Is there a method you could follow in a
                different task? Edit vague advice; decline unsupported claims.
              </li>
              <li>
                <strong>3. Add your missing context.</strong>
                <br />
                Correct attribution, uncertainty, and private details. Add a
                missing insight if useful. Apply edits and wait for saving
                before leaving.
              </li>
            </ol>
            {hasWorkflowField(review.protocolVersion) && (
              <p className="text-muted-foreground">
                Description: what the skill does and when to use it. Workflow:
                the reusable method. Example: how it was applied, with the
                actual outcome made clear.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              These are review prompts, not an evaluation score. A readable card
              still needs testing on new tasks.
            </p>
          </div>
          <SheetFooter>
            <Button onClick={() => changeOpen(false)}>Start reviewing</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

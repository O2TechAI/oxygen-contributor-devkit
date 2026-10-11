import { hasWorkflowField, type Review } from '@/lib/review-types';

export function ReviewGuide({
  review,
  onNext,
}: {
  review: Review;
  onNext: (id: string) => void;
}) {
  const resolved = review.insights.filter(
    (card) => card.status === 'accepted' || card.status === 'rejected',
  );
  const next = review.insights.find(
    (card) => card.status !== 'accepted' && card.status !== 'rejected',
  );
  const accepted = resolved.filter((card) => card.status === 'accepted').length;

  return (
    <section
      aria-label="Review guide"
      className="mx-3 mt-3 shrink-0 rounded-md border bg-[color:var(--ui-callout)] sm:mx-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="text-sm font-medium">
            Your corrections are part of the contribution.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Keep the useful method. Preserve what actually happened. Declining a
            weak card is useful too.
          </p>
        </div>
        <a
          href="/contribute"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-primary underline underline-offset-4"
        >
          Why contribute? ↗
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t px-4 py-2 text-xs">
        <span>
          {resolved.length} of {review.insights.length} cards decided
        </span>
        {review.insights.length > 0 && (
          <progress
            aria-label="Cards decided"
            className="h-1.5 w-24 accent-[var(--primary)]"
            value={resolved.length}
            max={review.insights.length}
          />
        )}
        <span className="text-muted-foreground">
          {accepted} accepted · {resolved.length - accepted} declined
        </span>
        {next ? (
          <button
            type="button"
            className="ml-auto font-medium text-primary hover:underline"
            onClick={() => onNext(next.id)}
          >
            Continue with {next.id} →
          </button>
        ) : (
          <span className="ml-auto text-muted-foreground">
            {review.insights.length
              ? 'Decisions recorded below; check the summary before completing.'
              : 'No cards to decide. Check for a missing insight before completing.'}
          </span>
        )}
      </div>
      <p className="break-all border-t px-4 py-2 text-xs text-muted-foreground">
        {review.projectName} · {review.sourcePath}
      </p>
      <details className="border-t px-4 py-2 text-xs">
        <summary className="cursor-pointer font-medium">
          A quick check for a useful contribution
        </summary>
        <ol className="mt-3 grid gap-3 pb-2 leading-5 sm:grid-cols-3">
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
            Correct attribution, uncertainty, and private details. Add a missing
            insight if useful. Apply edits and wait for saving before leaving.
          </li>
        </ol>
        {hasWorkflowField(review.protocolVersion) && (
          <p className="pb-2 text-muted-foreground">
            Description: what the skill does and when to use it. Workflow: the
            reusable method. Example: how it was applied, with the actual
            outcome made clear.
          </p>
        )}
        <p className="pb-2 text-muted-foreground">
          These are review prompts, not an evaluation score. A readable card
          still needs testing on new tasks.
        </p>
      </details>
    </section>
  );
}

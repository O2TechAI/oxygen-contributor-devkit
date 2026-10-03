'use client';

import type { ReactNode } from 'react';
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PencilLine, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { SummaryLine } from '@/lib/review-types';
import { cn } from '@/lib/utils';

type MarkdownNode = ExtraProps['node'];

type RichSummaryProps = {
  markdown: string;
  lines: SummaryLine[];
  evidence: Set<string>;
  onEdit: (lineId: string) => void;
  onDelete: (lineId: string) => void;
};

function sourceLines(node: MarkdownNode, lines: SummaryLine[]) {
  const start = Math.max(0, (node?.position?.start.line ?? 1) - 1);
  const end = Math.min(lines.length, node?.position?.end.line ?? start + 1);
  return lines.slice(start, end);
}

function SummaryBlock({
  node,
  lines,
  evidence,
  onEdit,
  onDelete,
  children,
}: RichSummaryProps & {
  node: MarkdownNode;
  children: ReactNode;
}) {
  const addressed = sourceLines(node, lines);
  const ids = addressed.map((line) => line.id);
  const firstId = ids[0];
  const highlighted = ids.some((id) => evidence.has(id));
  const modified = addressed.some(
    (line) => line.text !== line.originalText || !line.originalText,
  );

  if (!firstId) return <>{children}</>;

  return (
    <div
      id={firstId}
      data-summary-lines={ids.join(' ')}
      className={cn(
        'group/summary grid scroll-mt-24 grid-cols-[minmax(0,1fr)_60px] gap-3 rounded-sm border-l-2 border-transparent px-3 py-2 transition-colors',
        highlighted &&
          'border-[color:var(--evidence-accent)] bg-[color:var(--evidence-bg)]',
      )}
    >
      <div className="min-w-0">
        {children}
        {modified && (
          <span className="mt-1 inline-block text-[10px] font-semibold uppercase text-[color:var(--insight-strong)]">
            Edited
          </span>
        )}
      </div>
      <div className="flex justify-end gap-1 self-start opacity-0 transition-opacity group-hover/summary:opacity-100 focus-within:opacity-100">
        <Button
          aria-label={`Edit ${firstId}`}
          title={`Edit ${firstId}`}
          variant="ghost"
          size="icon-sm"
          onClick={() => onEdit(firstId)}
        >
          <PencilLine />
        </Button>
        <Button
          aria-label={`Remove ${firstId}`}
          title={`Remove ${firstId}`}
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(firstId)}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

export function RichSummary(props: RichSummaryProps) {
  const block = (node: MarkdownNode, children: ReactNode) => (
    <SummaryBlock {...props} node={node}>
      {children}
    </SummaryBlock>
  );

  const components: Components = {
    h1: ({ node, children }) =>
      block(
        node,
        <h2 className="text-2xl font-semibold leading-9">{children}</h2>,
      ),
    h2: ({ node, children }) =>
      block(
        node,
        <h3 className="text-xl font-semibold leading-8">{children}</h3>,
      ),
    h3: ({ node, children }) =>
      block(
        node,
        <h4 className="text-lg font-semibold leading-7">{children}</h4>,
      ),
    h4: ({ node, children }) =>
      block(
        node,
        <h5 className="text-base font-semibold leading-7">{children}</h5>,
      ),
    h5: ({ node, children }) =>
      block(
        node,
        <h6 className="text-sm font-semibold leading-6">{children}</h6>,
      ),
    h6: ({ node, children }) =>
      block(
        node,
        <p className="text-sm font-semibold leading-6">{children}</p>,
      ),
    p: ({ node, children }) =>
      block(
        node,
        <p className="text-[15px] leading-7 text-foreground/90">{children}</p>,
      ),
    ol: ({ children }) => (
      <ol className="my-2 list-decimal space-y-1 pl-7 marker:font-semibold marker:text-muted-foreground">
        {children}
      </ol>
    ),
    ul: ({ children }) => (
      <ul className="my-2 list-disc space-y-1 pl-7 marker:text-muted-foreground">
        {children}
      </ul>
    ),
    li: ({ children }) => <li className="pl-1">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-[color:var(--evidence-border)] pl-4 text-muted-foreground">
        {children}
      </blockquote>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-[color:var(--evidence-strong)] underline decoration-[color:var(--evidence-border)] underline-offset-4"
      >
        {children}
      </a>
    ),
    code: ({ children, className }) => (
      <code
        className={cn(
          className,
          'rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground',
        )}
      >
        {children}
      </code>
    ),
    pre: ({ node, children }) =>
      block(
        node,
        <pre className="overflow-x-auto rounded-md border bg-muted/50 p-4 text-sm leading-6 [&_code]:bg-transparent [&_code]:p-0">
          {children}
        </pre>,
      ),
    table: ({ node, children }) =>
      block(
        node,
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            {children}
          </table>
        </div>,
      ),
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    th: ({ children }) => (
      <th className="border px-3 py-2 font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="border px-3 py-2">{children}</td>,
    hr: ({ node }) =>
      block(node, <hr className="my-3 border-[color:var(--border)]" />),
    input: ({ node: _node, ...inputProps }) => (
      <input
        {...inputProps}
        className="mr-2 size-4 accent-[color:var(--primary)]"
      />
    ),
  };

  return (
    <div className="rich-summary">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {props.markdown}
      </ReactMarkdown>
    </div>
  );
}

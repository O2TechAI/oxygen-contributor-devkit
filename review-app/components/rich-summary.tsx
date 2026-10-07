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
        'group/summary grid scroll-mt-24 grid-cols-[minmax(0,1fr)_60px] gap-2 rounded-[4px] px-2 py-0.5 transition-colors hover:bg-[rgba(55,53,47,0.03)]',
        highlighted &&
          'bg-[color:var(--evidence-bg)] hover:bg-[color:var(--evidence-bg)] shadow-[inset_2px_0_0_var(--evidence-accent)]',
      )}
    >
      <div className="min-w-0">
        {children}
        {modified && (
          <span className="mt-1 inline-block rounded-[3px] bg-[#fdecc8] px-1.5 text-xs text-[#402c1b]">
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
        <h2 className="mt-6 mb-1 text-[1.875rem] font-bold leading-[1.2] tracking-[-0.01em]">{children}</h2>,
      ),
    h2: ({ node, children }) =>
      block(
        node,
        <h3 className="mt-5 mb-px text-[1.5rem] font-semibold leading-[1.3]">{children}</h3>,
      ),
    h3: ({ node, children }) =>
      block(
        node,
        <h4 className="mt-4 mb-px text-[1.25rem] font-semibold leading-[1.3]">{children}</h4>,
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
        <p className="py-[3px] text-base leading-[1.6]">{children}</p>,
      ),
    ol: ({ children }) => (
      <ol className="my-1 list-decimal space-y-1 pl-6 leading-[1.6]">
        {children}
      </ol>
    ),
    ul: ({ children }) => (
      <ul className="my-1 list-disc space-y-1 pl-6 leading-[1.6]">
        {children}
      </ul>
    ),
    li: ({ children }) => <li className="pl-1">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-1 border-l-[3px] border-foreground pl-4 text-base">
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
        className="text-foreground underline decoration-[rgba(55,53,47,0.4)] underline-offset-2 hover:decoration-foreground"
      >
        {children}
      </a>
    ),
    code: ({ children, className }) => (
      <code
        className={cn(
          className,
          'rounded-[4px] bg-[color:var(--ui-code-bg)] px-[0.3em] py-[0.15em] font-mono text-[85%] text-[color:var(--ui-code-fg)]',
        )}
      >
        {children}
      </code>
    ),
    pre: ({ node, children }) =>
      block(
        node,
        <pre className="overflow-x-auto rounded-[4px] bg-[#f7f6f3] px-8 py-6 font-mono text-[85%] leading-[1.5] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-foreground">
          {children}
        </pre>,
      ),
    table: ({ node, children }) =>
      block(
        node,
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm leading-[1.5]">
            {children}
          </table>
        </div>,
      ),
    thead: ({ children }) => <thead className="bg-[#f7f6f3]">{children}</thead>,
    th: ({ children }) => (
      <th className="border border-[#e9e9e7] px-2 py-1.5 font-medium text-muted-foreground">{children}</th>
    ),
    td: ({ children }) => <td className="border border-[#e9e9e7] px-2 py-1.5">{children}</td>,
    hr: ({ node }) =>
      block(node, <hr className="my-3 border-[#e9e9e7]" />),
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

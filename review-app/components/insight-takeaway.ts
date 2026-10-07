import { createElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function InsightTakeaway({ markdown }: { markdown: string }) {
  // Older generated Takeaways were plain single-line text, including literal
  // angle-bracket placeholders. Preserve that display until Markdown is used.
  const plain = !/[\r\n]/.test(markdown) && !/^\*\*[^*\n]+\*\*/.test(markdown);
  return createElement(
    'div',
    { className: 'mt-1 space-y-2 text-[15px] leading-[1.6] text-foreground' },
    plain
      ? createElement('p', null, markdown)
      : createElement(
          Markdown,
          {
            skipHtml: true,
            // Cards are clickable: render prose and emphasis without nested links,
            // controls, or other interactive Markdown elements.
            allowedElements: ['p', 'strong', 'em', 'code', 'br'],
            unwrapDisallowed: true,
          },
          markdown,
        ),
  );
}

// Skill candidates preserve developed Markdown in both cards and previews.
export function InsightProse({ markdown }: { markdown: string }) {
  return createElement(
    'div',
    {
      className:
        'mt-1 min-w-0 space-y-2 break-words text-[15px] leading-[1.6] text-foreground [&_code]:rounded-[4px] [&_code]:bg-[color:var(--ui-code-bg)] [&_code]:px-[0.3em] [&_code]:text-[85%] [&_code]:text-[color:var(--ui-code-fg)] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground [&_h2]:mt-5 [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:font-medium [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-1 [&_blockquote]:border-l-[3px] [&_blockquote]:border-foreground [&_blockquote]:pl-4 [&_pre]:overflow-x-auto [&_pre]:rounded-[4px] [&_pre]:bg-[#f7f6f3] [&_pre]:p-4 [&_pre]:text-sm [&_pre]:whitespace-pre [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_th]:border [&_th]:border-[#e9e9e7] [&_th]:bg-[#f7f6f3] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border [&_td]:border-[#e9e9e7] [&_td]:px-2 [&_td]:py-1.5',
    },
    createElement(
      Markdown,
      {
        skipHtml: true,
        remarkPlugins: [remarkGfm],
        allowedElements: [
          'p',
          'strong',
          'em',
          'del',
          'code',
          'pre',
          'br',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'ol',
          'ul',
          'li',
          'blockquote',
          'table',
          'thead',
          'tbody',
          'tr',
          'th',
          'td',
          'hr',
        ],
        unwrapDisallowed: true,
        components: {
          table: ({ children }) =>
            createElement(
              'div',
              { className: 'max-w-full overflow-x-auto' },
              createElement('table', null, children),
            ),
        },
      },
      markdown,
    ),
  );
}

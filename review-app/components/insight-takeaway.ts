import { createElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function InsightTakeaway({ markdown }: { markdown: string }) {
  // Older generated Takeaways were plain single-line text, including literal
  // angle-bracket placeholders. Preserve that display until Markdown is used.
  const plain = !/[\r\n]/.test(markdown) && !/^\*\*[^*\n]+\*\*/.test(markdown);
  return createElement(
    'div',
    { className: 'mt-2 space-y-3 text-[15px] leading-7' },
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
        'mt-2 min-w-0 space-y-3 break-words text-[15px] leading-7 [&_h2]:mt-5 [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:font-medium [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:italic [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-sm [&_pre]:whitespace-pre [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_td]:border [&_td]:px-3 [&_td]:py-2',
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

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

/**
 * Renders agent-authored GFM Markdown (Ask answers, see buildAskPrompt) with our theme tokens.
 * XSS-safe by construction: react-markdown strips raw HTML by default and we add no rehype-raw,
 * so `source` is treated as Markdown text, never as HTML. The root has no className prop, so the
 * wrapper <div> carries the base text styling.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-3 mb-1 text-base font-semibold text-fg">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-sm font-semibold text-fg">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold text-fg">{children}</h3>,
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-300 underline hover:text-indigo-200"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  // Inline code. v10 drops the `inline` prop, so block code is styled on <pre> instead (which
  // wraps a nested <code>); the [&_code] neutralizers there reset this inline look for fenced code.
  code: ({ children }) => (
    <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md border border-border bg-bg-2 p-3 text-xs [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-fg">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-panel-2 px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 text-left">{children}</td>,
  hr: () => <hr className="border-border" />,
};

export function Markdown({ source }: { source: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-fg">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

import ReactMarkdown, { type Components } from "react-markdown";

/** Longest text rendered. Longer text is cut and ends in "...". */
export const MARKDOWN_MAX_CHARS = 4000;

// Text can come from a third-party MCP server, so it is untrusted: no raw HTML
// (react-markdown's default, never add rehype-raw), no images (they would fetch
// a URL), and only http, https and mailto links.
const ALLOWED_ELEMENTS = ["p", "strong", "em", "code", "pre", "ul", "ol", "li", "a", "br", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"];

const SAFE_URL = /^(https?:|mailto:)/i;

// A link with no scheme (relative, or "#x") has no way to reach javascript:, but
// there is nothing for it to point at inside a description, so it is dropped too.
function urlTransform(url: string): string {
  return SAFE_URL.test(url.trim()) ? url : "";
}

const heading = ({ node: _node, ...props }: { node?: unknown } & React.HTMLAttributes<HTMLHeadingElement>) => (
  <h4 {...props} className="wb-md-heading" />
);

const components: Components = {
  a: ({ node: _node, href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
};

export function Markdown({ children }: { children: string }) {
  if (!children.trim()) return null;
  const text = children.length > MARKDOWN_MAX_CHARS ? `${children.slice(0, MARKDOWN_MAX_CHARS)}...` : children;
  return (
    <div className="wb-md">
      <ReactMarkdown allowedElements={ALLOWED_ELEMENTS} unwrapDisallowed urlTransform={urlTransform} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

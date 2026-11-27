import type { ReactNode } from "react";

export interface BoxProps {
  title?: ReactNode;
  /** Sits right beside the title, on the left of the header, outside the heading element. */
  titleAside?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

// The one structural container this UI is built from: a bordered surface with
// an optional header strip, holding rows that are divided by hairlines rather
// than separated by gaps. Nothing here casts a shadow — depth is not how this
// interface communicates hierarchy.
export function Box({ title, titleAside, action, className, children }: BoxProps) {
  return (
    <section className={["ui-box", className].filter(Boolean).join(" ")}>
      {(title || action) && (
        <header className="ui-box-head">
          {titleAside ? (
            <div className="ui-box-heading">
              {title && <h2 className="ui-box-title">{title}</h2>}
              {titleAside}
            </div>
          ) : (
            title && <h2 className="ui-box-title">{title}</h2>
          )}
          {action && <div className="ui-box-action">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function BoxRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={["ui-box-row", className].filter(Boolean).join(" ")}>{children}</div>;
}

import type { ReactNode } from "react";

// Every page opens the same way: an h1 and, when the page needs one, a single
// row of controls beneath it separated by a hairline.
export function PageHeader({ title, icon, actions, toolbar }: { title: string; icon?: ReactNode; actions?: ReactNode; toolbar?: ReactNode }) {
  return (
    <header className="wb-page-head">
      <div className="wb-page-title-row">
        {icon ? (
          <div className="wb-page-title-with-icon">
            {icon}
            <h1 className="wb-page-title">{title}</h1>
          </div>
        ) : (
          <h1 className="wb-page-title">{title}</h1>
        )}
        {actions && <div className="wb-page-actions">{actions}</div>}
      </div>
      {toolbar && <div className="wb-page-toolbar">{toolbar}</div>}
    </header>
  );
}

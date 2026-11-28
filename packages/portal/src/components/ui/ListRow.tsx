import type { ReactNode } from "react";
import { BoxRow } from "./Box";

export interface ListRowProps {
  /** A slot before the icon tile, for a selection checkbox. */
  leading?: ReactNode;
  /** The glyph inside the icon tile. Omit for a row with no tile. */
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Badges and other chips, shown beside the title (wrapping under it on narrow screens). */
  chips?: ReactNode;
  /** Usually a `RowActions` group. */
  actions?: ReactNode;
  /** Makes the title a native button. The row itself is never a click target. */
  onOpen?: () => void;
  className?: string;
}

/**
 * The one list row: icon tile, title, subtitle, chips and actions, on top of
 * BoxRow. Controls inside are real buttons in the plain tab order; the row is
 * not a click target wrapped around them.
 */
export function ListRow({ leading, icon, title, subtitle, chips, actions, onOpen, className }: ListRowProps) {
  return (
    <BoxRow className={["ui-list-row", className].filter(Boolean).join(" ")}>
      {leading && <div className="ui-list-row-leading">{leading}</div>}
      {icon && (
        <span className="ui-list-row-tile" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="ui-list-row-main">
        <div className="ui-list-row-line">
          {onOpen ? (
            <button type="button" className="ui-list-row-title ui-list-row-title-button" onClick={onOpen}>
              {title}
            </button>
          ) : (
            <span className="ui-list-row-title">{title}</span>
          )}
          {chips && <span className="ui-list-row-chips">{chips}</span>}
        </div>
        {subtitle && <div className="ui-list-row-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="ui-list-row-actions">{actions}</div>}
    </BoxRow>
  );
}

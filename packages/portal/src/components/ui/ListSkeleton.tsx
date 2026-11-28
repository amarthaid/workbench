/** Placeholder rows with the real row height, so a list does not jump when its data arrives. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ui-box-row ui-list-row ui-list-skeleton-row">
          <span className="ui-list-row-tile ui-list-skeleton-bar" aria-hidden="true" />
          <div className="ui-list-row-main">
            <span className="ui-list-skeleton-bar ui-list-skeleton-title" aria-hidden="true" />
            <span className="ui-list-skeleton-bar ui-list-skeleton-sub" aria-hidden="true" />
          </div>
        </div>
      ))}
    </div>
  );
}

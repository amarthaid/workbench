import type { ReactNode } from "react";

export interface Stat {
  label: string;
  value: ReactNode;
  /** Show a placeholder bar instead of the value: nothing real to say yet. */
  loading?: boolean;
}

export function StatStrip({ stats, note }: { stats: Stat[]; note?: ReactNode }) {
  return (
    <section className="ui-box">
      <div className="ui-stat-cells">
        {stats.map((s) => (
          <div key={s.label} className="ui-stat">
            <div className="ui-stat-label">{s.label}</div>
            <div className="ui-stat-value">
              {s.loading ? <span role="status" aria-label="Loading" className="ui-stat-skeleton" /> : s.value}
            </div>
          </div>
        ))}
      </div>
      {note && <div className="ui-stat-note">{note}</div>}
    </section>
  );
}

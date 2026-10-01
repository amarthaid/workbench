import type { ReactNode } from "react";

// How long an overview card's data counts as fresh. The default of 0 makes React
// Query refetch on every window focus, which for the profiles card means walking
// every browser profile on disk each time an admin alt-tabs back.
export const ADMIN_STALE_MS = 60_000;

// The loading and error states every overview card shares, so each card only
// has to say what it renders once its data has arrived.
export function CardBody({
  isLoading,
  isError,
  label,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  label: string;
  children: ReactNode;
}) {
  if (isLoading) return <div className="ui-loading">Loading {label}…</div>;
  if (isError) return <div className="ui-form-error">Couldn't load {label}.</div>;
  return <>{children}</>;
}

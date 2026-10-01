import type { ReactNode } from "react";

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

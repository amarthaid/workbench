import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import type { ConfirmRequest } from "./bridge";

function summarize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const n = Object.keys(value as object).length;
    return `${n} field${n === 1 ? "" : "s"}`;
  }
  return String(value);
}

function rawJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return String(value);
  }
}

// Drawn by the shell, outside the Space's frame, so the Space can neither
// paint over it nor click it. Closing it any way other than Allow is a Deny.
export function ConfirmActionModal({
  request,
  onAllow,
  onDeny,
}: {
  request: ConfirmRequest | null;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const args = request?.args;
  const entries =
    args && typeof args === "object" && !Array.isArray(args) ? Object.entries(args as Record<string, unknown>) : null;

  return (
    <Modal
      open={request !== null}
      onClose={onDeny}
      title="Allow this action?"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onDeny}>Deny</Button>
          <Button variant="danger" onClick={onAllow}>Allow</Button>
        </>
      }
    >
      {request && (
        <div className="space-confirm">
          <p>
            This Space wants to run <span className="wb-mono">{request.tool}</span> on{" "}
            <strong>{request.integrationName}</strong> as you. This action can change or delete data, or act on your
            behalf.
          </p>
          {request.description && <p className="space-muted">{request.description}</p>}
          {entries && entries.length > 0 ? (
            <dl className="space-confirm-args">
              {entries.map(([k, v]) => (
                <div key={k} className="space-confirm-arg">
                  <dt>{k}</dt>
                  <dd>{summarize(v)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            args !== undefined && !entries && <p className="space-muted">Arguments: {summarize(args)}</p>
          )}
          <details className="space-confirm-raw">
            <summary>Raw arguments</summary>
            <pre className="wb-code">{rawJson(args ?? {})}</pre>
          </details>
        </div>
      )}
    </Modal>
  );
}

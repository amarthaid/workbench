import { AuditEvent } from "@a-workbench/shared";
import { AuditDestination, createDestination } from "./destinations";
import { captureValue, payloadLimits, payloadMode } from "./payload";
import { auditUserEmail } from "./user-email";

/**
 * What callers pass. `args` / `result` are the live values; whether they are
 * recorded, and in what form, is decided here (AUDIT_PAYLOAD, sanitised and
 * capped by src/audit/payload.ts), never at the call site.
 */
export type AuditInput = Omit<
  AuditEvent,
  "timestamp" | "user_email" | "args" | "args_truncated" | "args_bytes" | "result" | "result_truncated" | "result_bytes"
> & {
  args?: unknown;
  result?: unknown;
};

export class AuditLogger {
  private destination: AuditDestination;

  constructor() {
    this.destination = createDestination();
  }

  async log(input: AuditInput): Promise<void> {
    const { args, result, ...event } = input;
    const fullEvent: AuditEvent = {
      ...event,
      user_email: await auditUserEmail(event.user_id),
      timestamp: new Date().toISOString(),
    };
    const mode = payloadMode();
    if (mode !== "off") {
      const limits = payloadLimits();
      const a = captureValue(args, limits.args);
      if (a) {
        fullEvent.args = a.text;
        fullEvent.args_truncated = a.truncated;
        fullEvent.args_bytes = a.bytes;
      }
      if (mode === "full") {
        const r = captureValue(result, limits.result);
        if (r) {
          fullEvent.result = r.text;
          fullEvent.result_truncated = r.truncated;
          fullEvent.result_bytes = r.bytes;
        }
      }
    }
    await this.destination.log(fullEvent);
  }
}

export const auditLogger = new AuditLogger();

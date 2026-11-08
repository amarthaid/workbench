import { AuditEvent } from "@a-workbench/shared";
import { AuditDestination, createDestination } from "./destinations";
import { captureValue, payloadLimits, payloadMode, redactInlineSecrets } from "./payload";
import { auditUserEmail } from "./user-email";
import { currentAuditContext } from "./context";
import { oauthClientName } from "./client-name";

/**
 * What callers pass. `args` / `result` are the live values; whether they are
 * recorded, and in what form, is decided here (AUDIT_PAYLOAD, sanitised and
 * capped by src/audit/payload.ts), never at the call site.
 */
export type AuditInput = Omit<
  AuditEvent,
  // Filled in here, never by callers.
  | "timestamp"
  | "user_email"
  | "source_ip"
  | "user_agent"
  | "auth_method"
  | "client_id"
  | "client_name"
  | "args"
  | "args_truncated"
  | "args_bytes"
  | "result"
  | "result_truncated"
  | "result_bytes"
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
      // Error text can quote a connection string or a request URL.
      ...(event.error ? { error: redactInlineSecrets(event.error) } : {}),
      user_email: await auditUserEmail(event.user_id),
      timestamp: new Date().toISOString(),
    };
    // Where the request came from and how it authenticated, when there was one.
    const ctx = currentAuditContext();
    if (ctx) {
      if (ctx.source_ip) fullEvent.source_ip = ctx.source_ip;
      if (ctx.user_agent) fullEvent.user_agent = ctx.user_agent;
      if (ctx.auth_method) fullEvent.auth_method = ctx.auth_method;
      if (ctx.client_id) fullEvent.client_id = ctx.client_id;
      // An explicit name (a Space's "space:<name>") wins over the OAuth lookup.
      if (ctx.client_name) {
        fullEvent.client_name = ctx.client_name;
      } else if (ctx.client_id) {
        const name = await oauthClientName(ctx.client_id);
        if (name) fullEvent.client_name = name;
      }
    }
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

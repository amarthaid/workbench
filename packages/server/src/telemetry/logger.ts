import { redactAudioPath } from "../audio/capability";
import { clientIp } from "../trust-proxy";

// Redact secrets from logs. req.url is kept visible for request tracing,
// except for the browser audio capability (a live call's only credential,
// valid for hours), which the req serializer masks. The jot upload token
// (/j/upload/<token>) is an opaque single-use handle with a few minutes' TTL
// and does still reach the logs, so treat them accordingly.
export const loggerOptions = {
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["x-workbench-api-key"]',
      "req.query.token",
      "req.query.cdpToken",
    ],
    remove: false,
    censor: "[REDACTED]",
  },
  serializers: {
    // remoteAddress is the client, resolved exactly as the audit log's
    // source_ip is (src/trust-proxy.ts): CLIENT_IP_HEADER from a trusted peer,
    // else X-Forwarded-For per TRUST_PROXY, else the socket. peerAddress is the
    // socket's own address (the load balancer, behind one), for tracing which
    // proxy a request came through.
    req: (req: {
      method?: string;
      url?: string;
      hostname?: string;
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remotePort?: number; remoteAddress?: string };
    }) => {
      let remoteAddress = req.ip;
      try {
        remoteAddress = clientIp({ ip: req.ip ?? "", headers: req.headers ?? {}, socket: req.socket } as never) ?? req.ip;
      } catch {
        // Never let address resolution break a log line.
      }
      return {
        method: req.method,
        url: redactAudioPath(req.url ?? ""),
        hostname: req.hostname,
        remoteAddress,
        peerAddress: req.socket?.remoteAddress,
        remotePort: req.socket?.remotePort,
      };
    },
  },
};

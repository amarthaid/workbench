import { redactAudioPath } from "../audio/capability";

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
    req: (req: { method?: string; url?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) => ({
      method: req.method,
      url: redactAudioPath(req.url ?? ""),
      hostname: req.hostname,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }),
  },
};

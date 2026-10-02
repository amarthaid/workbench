export interface Integration {
  name: string;
  version: string;
  auth: OAuthConfig | ApiKeyConfig | CookieConfig | NoneConfig;
  // Optional presentation metadata (portal + agent UX). All backward-compatible.
  displayName?: string;
  description?: string;
  // Logo: either an https URL (used as-is) or a filename bundled in the plugin
  // dir (served via /api/integrations/:name/logo).
  logo?: string;
  categories?: string[];
  // When set, enables the curl proxy for this integration. The agent can call
  // curl_session to mint a short-lived token and then hit /c/<name>/... to
  // proxy arbitrary API calls with the user's stored credential injected.
  //
  // Either `baseUrl` (static) or `resolver` (dynamic, resolved server-side
  // from per-connection config at request time) must be set.
  proxy?: {
    // Static API base URL, e.g. "https://api.github.com". May also be a
    // template using "cloud-id" as a placeholder for Atlassian integrations
    // — ctx.http() resolves it automatically.
    baseUrl?: string;
    // Dynamic resolver name. The proxy resolves the real base URL at request
    // time using per-connection config stored at connect time.
    resolver?: "instance-url" | "newrelic-region";
    // Path suffix appended to the resolved instance URL (used with
    // resolver: "instance-url"), e.g. "/api/v4".
    pathPrefix?: string;
  };
}

export interface OAuthConfig {
  type: "oauth2";
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  // Self-hosted support. When set, the integration accepts a user-supplied
  // instance base URL at connect time (e.g. a private GitLab at
  // https://gitlab.acme.com). The authorize/token URLs above act as the
  // cloud default; for a custom instance the server keeps their *paths* and
  // swaps in the user's origin. The chosen instance origin is persisted on the
  // connection and exposed to tools via ctx.getConfig().instanceUrl so they can
  // build the right API base. Cloud-only integrations omit this block.
  instance?: {
    // Portal field label, e.g. "GitLab instance URL".
    label: string;
    // Placeholder shown in the portal input, e.g. "https://gitlab.example.com".
    placeholder?: string;
    // Prefilled default origin, e.g. "https://gitlab.com" (the cloud host).
    default: string;
  };
}

export interface ApiKeyConfig {
  type: "apikey";
  // Header the credential is sent in, e.g. "Api-Key" (New Relic) or
  // "Authorization". The value is the secret field below, sent verbatim (no
  // "Bearer " prefix — bake any scheme into the value if one is needed).
  headerName: string;
  // Connect-time form fields shown in the portal. Exactly one field marks the
  // credential with `secret: true` — it's stored encrypted as the connection's
  // access token and attached to ctx.http() as `headerName`. Any remaining
  // fields (e.g. an account region) are stored as per-connection config and
  // surfaced to tools via ctx.getConfig()[field.key].
  fields: ApiKeyField[];
  // Hosts ctx.http() is allowed to send the API key to. When set, the server
  // rejects any request to a host not in this list (exact match or a subdomain)
  // before attaching the credential — the apikey analogue of cookieDomains.
  //
  // PLUGIN CONTRACT: unlike the cookie/oauth branches, ctx.http() for apikey
  // auth performs NO host validation when this is omitted. A plugin that passes
  // a user- or tool-supplied URL to ctx.http() MUST set allowedHosts (or guard
  // the host itself) or it will forward the API key to whatever host it's given.
  allowedHosts?: string[];
}

export interface ApiKeyField {
  // Form name + config/getConfig() key, e.g. "apiKey" or "region".
  key: string;
  // Portal field label, e.g. "New Relic User API Key".
  label: string;
  // Helper text shown under the label.
  description?: string;
  // Placeholder shown in the input.
  placeholder?: string;
  // The credential itself — stored encrypted, rendered as a masked input.
  // Exactly one field per integration should set this.
  secret?: boolean;
  // Optional fixed choices — rendered as a <select> instead of a text input.
  options?: string[];
  // When true the field may be left blank at connect time (e.g. a default
  // account id tools fall back to). Non-optional fields are required.
  optional?: boolean;
  // When true renders a multiline textarea (e.g. for JSON arrays). Works with
  // secret fields as well — still encrypted but shown as a textbox.
  multiline?: boolean;
}

export interface CookieConfig {
  type: "cookie";
  loginUrl: string;
  targetDomain: string;
  cookieDomains?: string[];
}

export interface NoneConfig {
  type: "none";
}

export interface ToolDefinition {
  name: string;
  description: string;
  integration: string;
  inputSchema: unknown;
}

export interface Connection {
  userId: string;
  integration: string;
  connectedAt: number;
  scopes: string[];
}

export interface AuditEvent {
  user_id: string;
  integration?: string;
  tool?: string;
  action:
    | "EXECUTE"
    | "CONNECT"
    | "DISCONNECT"
    | "REFRESH"
    | "ADMIN_USER_DISABLE"
    | "ADMIN_USER_ENABLE"
    | "ADMIN_KEY_REVOKE"
    | "ADMIN_INTEGRATION_SET"
    | "ADMIN_CUSTOM_APPS_POLICY";
  success: boolean;
  error?: string;
  duration_ms?: number;
  timestamp: string;
}

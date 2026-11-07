import { z } from "zod";

export type CleverTapRegion = "in1" | "us1" | "eu1" | "sg1" | "aps3" | "mec1";

interface Project {
  name: string;
  accountId: string;
  passcode: string;
  region: CleverTapRegion;
}

const VALID_REGIONS: CleverTapRegion[] = ["in1", "us1", "eu1", "sg1", "aps3", "mec1"];

// Strict YYYYMMDD — CleverTap 500s on YYYY-MM-DD. Normalize and validate early
// so the error is actionable instead of a generic 500.
function toYYYYMMDD(input: string): string {
  const s = input.trim();
  if (/^\d{8}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  const m2 = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m2) return `${m2[1]}${m2[2]}${m2[3]}`;
  throw new Error(`Invalid date "${input}" — must be YYYYMMDD 8 digits without dashes (e.g. "20260617"), not "${input}". Remove dashes/slashes.`);
}
const YYYYMMDD_DESC = 'Strict YYYYMMDD 8 digits without dashes (e.g. "20260617"). If you have "2026-06-17", remove dashes → "20260617".';
const SYSTEM_EVENTS_INFO = 'System events: App Installed, App Launched, App Uninstalled, UTM Visited, Notification Sent/Viewed/Clicked, Charged etc. See https://developer.clevertap.com/docs/events#system-events. System props: CT App version, CT Latitude etc (@CT). See https://developer.clevertap.com/docs/events#system-properties.';
const PREDEFINED_PROFILE_INFO = 'Predefined profile props: Name, Identity, Email, Phone, Gender, DOB, Photo, MSG-email, MSG-push, MSG-sms, MSG-whatsapp. See https://developer.clevertap.com/docs/concepts-user-profiles#manually-updating-predefined-user-profile-properties.';
const CQL_INFO = 'CQL: event_properties, session_properties, common_profile_properties (app_fields, profile_fields, demographics, technographics, reachability, geo_fields), advanced_query (did_none/did_all/did_any), likelihood. See https://developer.clevertap.com/docs/clevertap-query-language. Use clevertap_request for full JSON.';

class CleverTapClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(cfg: Project) {
    // ponytail: bare fetch by design — token is JSON array of projects, can't be single headerName via ctx.http (would send JSON as header). Region enum + allowedHosts clevertap.com guard host instead. ctx.http would inject JSON token as X-CleverTap-Account-Id, wrong.
    if (!VALID_REGIONS.includes(cfg.region)) throw new Error(`Invalid region ${cfg.region}`);
    this.baseUrl = `https://${cfg.region}.api.clevertap.com/1`;
    // Validate host is clevertap subdomain before any request (mirrors apikey allowedHosts check)
    const host = new URL(this.baseUrl).hostname.toLowerCase();
    if (!host.endsWith(".clevertap.com")) throw new Error(`Blocked host ${host} — not in allowedHosts clevertap.com`);
    this.headers = {
      "X-CleverTap-Account-Id": cfg.accountId,
      "X-CleverTap-Passcode": cfg.passcode,
      "Content-Type": "application/json",
    };
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), { method: "GET", headers: this.headers });
    if (!res.ok) throw new Error(`CleverTap API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CleverTap API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async postWithPolling<T extends { status: string; req_id?: string }>(
    path: string,
    body: unknown,
    maxAttempts = 15,
    delayMs = 3000
  ): Promise<T> {
    let result = await this.post<T>(path, body);
    let attempts = 0;
    while (result.status === "partial" && result.req_id && attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
      result = await this.get<T>(path, { req_id: result.req_id });
      attempts++;
    }
    return result;
  }

  async delete<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`CleverTap API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }
}

async function loadProjects(ctx: any): Promise<Project[]> {
  let token: string;
  try {
    token = await ctx.getToken();
  } catch {
    throw new Error("Not connected — connect CleverTap in portal first.");
  }
  const cfg = ctx.getConfig() as Record<string, unknown>;

  // New shape: token is JSON array of projects (encrypted)
  try {
    const parsed = JSON.parse(token);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].accountId && parsed[0].passcode) {
      return parsed.map((p: any) => ({
        name: String(p.name),
        accountId: String(p.accountId),
        passcode: String(p.passcode),
        region: (VALID_REGIONS.includes(p.region) ? p.region : "us1") as CleverTapRegion,
      }));
    }
  } catch {
    // fall through to legacy
  }

  // Legacy single-project: token is passcode string, cfg holds accountId/region/projectName
  const accountId = cfg.accountId as string | undefined;
  const region = (cfg.region as string) || "us1";
  const projectName = (cfg.projectName as string) || "default";
  if (accountId && token) {
    return [{ name: projectName, accountId, passcode: token, region: region as CleverTapRegion }];
  }
  throw new Error("Not connected — connect CleverTap in portal first.");
}

async function resolveProject(ctx: any, name?: string): Promise<Project> {
  const projects = await loadProjects(ctx);
  if (!name) return projects[0];
  const found = projects.find((p) => p.name === name);
  if (!found) throw new Error(`Unknown project "${name}". Available: ${projects.map((p) => p.name).join(", ")}`);
  return found;
}

async function saveProjects(ctx: any, projects: Project[]): Promise<void> {
  const { storeToken } = await import("../../../server/src/auth/tokens");
  await storeToken(ctx.userId, "clevertap", {
    accessToken: JSON.stringify(projects),
    scopes: "",
    config: JSON.stringify({ version: 1 }),
  });
}

export const listProjects = {
  name: "clevertap_list_projects",
  description: "List all configured CleverTap projects (name, account ID, region).",
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({}),
  handler: async (ctx: any) => {
    const projects = await loadProjects(ctx);
    return {
      count: projects.length,
      projects: projects.map((p) => ({ name: p.name, accountId: p.accountId, region: p.region })),
      hint: 'Pass "project": "<name>" to any tool to target a specific project. Omit for default.',
    };
  },
};

export const setProjects = {
  name: "clevertap_set_projects",
  description: "Set all CleverTap projects at once via JSON. Overwrites existing. Use for multi-account bulk config. Input is JSON array: [{\"name\":\"prod\",\"accountId\":\"XXX\",\"passcode\":\"YYY\",\"region\":\"us1\"}]. Local store only, not a CleverTap API write.",
  integration: "clevertap",
  effect: "destructive",
  inputSchema: z.object({
    projects: z
      .array(
        z.object({
          name: z.string().min(1).describe('Unique label, e.g. "production"'),
          accountId: z.string().min(1).describe("CleverTap Account ID"),
          passcode: z.string().min(1).describe("CleverTap Passcode"),
          region: z.enum(["in1", "us1", "eu1", "sg1", "aps3", "mec1"]).default("us1" as const),
        })
      )
      .min(1)
      .optional()
      .describe("Projects array. Provide either this or projectsJson."),
    projectsJson: z
      .string()
      .optional()
      .describe('Raw JSON string alternative, e.g. \'[{"name":"prod","accountId":"XXX","passcode":"YYY","region":"us1"}]\''),
  }),
  handler: async (ctx: any, args: any) => {
    let projects: Project[];
    if (args.projects) {
      projects = args.projects as Project[];
    } else if (args.projectsJson) {
      try {
        const parsed = JSON.parse(args.projectsJson);
        if (!Array.isArray(parsed)) throw new Error("projectsJson must be a JSON array");
        projects = parsed as Project[];
      } catch (e) {
        throw new Error(`Invalid projectsJson: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      throw new Error("Provide projects or projectsJson");
    }
    // Validate
    for (const p of projects) {
      if (!p.name || !p.accountId || !p.passcode) throw new Error(`Each project needs name, accountId, passcode — got ${JSON.stringify(p)}`);
      if (!VALID_REGIONS.includes(p.region as CleverTapRegion)) p.region = "us1" as CleverTapRegion;
    }
    const names = projects.map((p) => p.name);
    if (new Set(names).size !== names.length) throw new Error(`Duplicate project names: ${names.join(", ")}`);
    await saveProjects(ctx, projects);
    return { success: true, count: projects.length, projects: projects.map((p) => ({ name: p.name, accountId: p.accountId, region: p.region })) };
  },
};

export const getEvents = {
  name: "clevertap_get_events",
  description: `Query event data for an event within a date range. ${YYYYMMDD_DESC} ${SYSTEM_EVENTS_INFO} ${CQL_INFO} Returns cursor for paginated results — use clevertap_get_events_cursor for next pages.`,
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    event_name: z.string().describe("Name of the event to query"),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
    groups: z.record(z.object({ property: z.string(), operator: z.enum(["avg", "sum", "min", "max", "count"]).optional() })).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { project, event_name, from, to, groups } = args as any;
    const client = new CleverTapClient(await resolveProject(ctx, project));
    const body: Record<string, unknown> = { event_name, from: parseInt(toYYYYMMDD(from)), to: parseInt(toYYYYMMDD(to)) };
    if (groups) body.groups = groups;
    return client.post("/events.json", body);
  },
};

export const getEventsCursor = {
  name: "clevertap_get_events_cursor",
  description: "Fetch next page of event results using cursor from clevertap_get_events.",
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    cursor: z.string().describe("Cursor from previous events query"),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.get("/events.json", { cursor: args.cursor });
  },
};

export const getEventCount = {
  name: "clevertap_get_event_count",
  description: `Count users who performed an event within date range. ${YYYYMMDD_DESC} ${SYSTEM_EVENTS_INFO} ${CQL_INFO} Supports property filters (event_properties, session_properties, common_profile_properties, advanced_query). Auto-polls if async.`,
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    event_name: z.string(),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
    event_properties: z.array(z.object({ name: z.string(), operator: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { project, event_name, from, to, event_properties } = args as any;
    const client = new CleverTapClient(await resolveProject(ctx, project));
    const body: Record<string, unknown> = { event_name, from: parseInt(toYYYYMMDD(from)), to: parseInt(toYYYYMMDD(to)) };
    if (event_properties) body.event_properties = event_properties;
    return client.postWithPolling("/counts/events.json", body);
  },
};

export const getProfile = {
  name: "clevertap_get_profile",
  description: `Retrieve a user profile by identity, email, or objectId (GUID). Provide at least one. ${PREDEFINED_PROFILE_INFO}`, 
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    identity: z.string().optional(),
    email: z.string().optional(),
    objectId: z.string().optional().describe("CleverTap GUID"),
  }),
  handler: async (ctx: any, args: any) => {
    if (!args.identity && !args.email && !args.objectId) throw new Error("Provide at least one of identity, email, or objectId");
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    const params: Record<string, string> = {};
    if (args.identity) params.identity = args.identity;
    if (args.email) params.email = args.email;
    if (args.objectId) params.objectId = args.objectId;
    return client.get("/profile.json", params);
  },
};

export const getProfilesByEvent = {
  name: "clevertap_get_profiles_by_event",
  description: `Get profiles of users who performed an event within date range. ${YYYYMMDD_DESC} ${SYSTEM_EVENTS_INFO} ${PREDEFINED_PROFILE_INFO} ${CQL_INFO} Returns cursor — use clevertap_get_profiles_cursor for next pages.`,
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    event_name: z.string(),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.post("/profiles.json?batch_size=50", {
      event_name: args.event_name,
      from: parseInt(toYYYYMMDD(args.from)),
      to: parseInt(toYYYYMMDD(args.to)),
    });
  },
};

export const getProfilesCursor = {
  name: "clevertap_get_profiles_cursor",
  description: "Fetch next page of profiles using cursor from clevertap_get_profiles_by_event.",
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    cursor: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.get("/profiles.json", { cursor: args.cursor });
  },
};

export const getProfileCount = {
  name: "clevertap_get_profile_count",
  description: `Count profiles who performed an event within date range. ${YYYYMMDD_DESC} ${SYSTEM_EVENTS_INFO} ${CQL_INFO} Supports property filters (event_properties, session_properties, common_profile_properties, advanced_query). Auto-polls if async.`, 
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    event_name: z.string(),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
    event_properties: z.array(z.object({ name: z.string(), operator: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { project, event_name, from, to, event_properties } = args as any;
    const client = new CleverTapClient(await resolveProject(ctx, project));
    const body: Record<string, unknown> = { event_name, from: parseInt(toYYYYMMDD(from)), to: parseInt(toYYYYMMDD(to)) };
    if (event_properties) body.event_properties = event_properties;
    return client.postWithPolling("/counts/profiles.json", body);
  },
};

export const getCampaigns = {
  name: "clevertap_get_campaigns",
  description: `List campaigns within date range (id, name, scheduled_on, status). ${YYYYMMDD_DESC}`,
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.post("/targets/list.json", { from: parseInt(toYYYYMMDD(args.from)), to: parseInt(toYYYYMMDD(args.to)) });
  },
};

export const getCampaignReport = {
  name: "clevertap_get_campaign_report",
  description: "Get delivery and engagement report for a campaign by numeric ID.",
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    id: z.number().int().describe("Campaign ID"),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.post("/targets/result.json", { id: args.id });
  },
};

export const getMessageReport = {
  name: "clevertap_get_message_report",
  description: `Get delivery/engagement report (sent, delivered, opened, clicked) filtered by channel, delivery type, status, label. ${YYYYMMDD_DESC}`,
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
    channel: z.array(z.string()).optional().describe("push, email, sms, browser, inapp, webhooks, whatsapp"),
    delivery: z.array(z.string()).optional(),
    daily: z.boolean().optional(),
    status: z.array(z.string()).optional(),
    message_type: z.array(z.string()).optional(),
    label: z.array(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { project, from, to, channel, delivery, daily, status, message_type, label } = args as any;
    const client = new CleverTapClient(await resolveProject(ctx, project));
    const body: Record<string, unknown> = { from: toYYYYMMDD(from), to: toYYYYMMDD(to) };
    if (channel) body.channel = channel;
    if (delivery) body.delivery = delivery;
    if (daily !== undefined) body.daily = daily;
    if (status) body.status = status;
    if (message_type) body.message_type = message_type;
    if (label) body.label = label;
    return client.post("/message/report.json", body);
  },
};

export const getTopPropertyCount = {
  name: "clevertap_get_top_property_count",
  description: `Get top property value counts for an event (e.g. top product categories). ${YYYYMMDD_DESC} ${SYSTEM_EVENTS_INFO} ${CQL_INFO} Auto-polls if async.`, 
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    event_name: z.string(),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
    groups: z.record(z.object({ property_type: z.string(), name: z.string(), top_n: z.number().optional(), order: z.enum(["asc", "desc"]).optional() })),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.postWithPolling("/counts/top.json", {
      event_name: args.event_name,
      from: parseInt(toYYYYMMDD(args.from)),
      to: parseInt(toYYYYMMDD(args.to)),
      groups: args.groups,
    });
  },
};

export const getEventTrend = {
  name: "clevertap_get_event_trend",
  description: `Get daily/weekly/monthly trend for an event. Supports unique count and sum of numeric property. ${YYYYMMDD_DESC} ${SYSTEM_EVENTS_INFO} ${CQL_INFO} Auto-polls if async.`, 
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    event_name: z.string(),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
    groups: z.record(z.object({ trend_type: z.enum(["daily", "weekly", "monthly"]) })),
    unique: z.boolean().optional(),
    sum_event_prop: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    const body: Record<string, unknown> = {
      event_name: args.event_name,
      from: parseInt(toYYYYMMDD(args.from)),
      to: parseInt(toYYYYMMDD(args.to)),
      groups: args.groups,
    };
    if (args.unique !== undefined) body.unique = args.unique;
    if (args.sum_event_prop) body.sum_event_prop = args.sum_event_prop;
    return client.postWithPolling("/counts/trends.json", body);
  },
};

export const getDau = {
  name: "clevertap_get_dau",
  description: `Get Daily Active Users trend (unique App Launched) for date range. ${YYYYMMDD_DESC}`,
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.postWithPolling("/counts/trends.json", {
      event_name: "App Launched",
      from: parseInt(toYYYYMMDD(args.from)),
      to: parseInt(toYYYYMMDD(args.to)),
      unique: true,
      groups: { daily: { trend_type: "daily" } },
    });
  },
};

export const getUninstallReport = {
  name: "clevertap_get_uninstall_report",
  description: `Get uninstall count trend for date range. ${YYYYMMDD_DESC}`,
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    from: z.string().describe(YYYYMMDD_DESC),
    to: z.string().describe(YYYYMMDD_DESC),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.postWithPolling("/counts/trends.json", {
      event_name: "Uninstalled",
      from: parseInt(toYYYYMMDD(args.from)),
      to: parseInt(toYYYYMMDD(args.to)),
      unique: true,
      groups: { daily: { trend_type: "daily" } },
    });
  },
};

export const getRealTimeCounts = {
  name: "clevertap_get_real_time_counts",
  description: "Get count of users active right now (last 5 minutes). Optionally breakdown by user type.",
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    user_type: z.boolean().optional().describe("Include breakdown by user type"),
  }),
  handler: async (ctx: any, args: any) => {
    const client = new CleverTapClient(await resolveProject(ctx, args.project));
    return client.post("/now.json", args.user_type ? { user_type: args.user_type } : {});
  },
};

export const request = {
  name: "clevertap_request",
  description: `Make any CleverTap API read request with full control over path, method, body, params. Supports full CQL (event_properties, session_properties, common_profile_properties, advanced_query, likelihood). See https://developer.clevertap.com/docs/clevertap-query-language. Prefer specific tools when available. For async partial responses use clevertap_poll. Note: dates in body must be YYYYMMDD integers, not YYYY-MM-DD strings.`,
  integration: "clevertap",
  effect: "destructive",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    path: z.string().describe('API path without base (e.g. "/counts/trends.json", "/profile.json")'),
    method: z.enum(["GET", "POST", "DELETE"]).default("GET"),
    body: z.preprocess((v) => (typeof v === "string" ? JSON.parse(v as string) : v), z.record(z.unknown())).optional(),
    params: z.record(z.string()).optional().describe("Query params for GET"),
    poll: z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean()).optional().default(false),
  }),
  handler: async (ctx: any, args: any) => {
    const { project, path, method, body, params, poll } = args as any;
    const client = new CleverTapClient(await resolveProject(ctx, project));
    const tryReq = async (m: string) => {
      if (m === "GET") return client.get(path, params);
      if (m === "DELETE") return client.delete(path, body);
      if (poll) return client.postWithPolling(path, body ?? {});
      return client.post(path, body ?? {});
    };
    try {
      return await tryReq(method);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("405")) {
        const fallback = method === "GET" ? "POST" : method === "POST" ? "GET" : method;
        const result: any = await tryReq(fallback);
        return { _note: `Original ${method} 405, retried with ${fallback}`, ...result };
      }
      throw err;
    }
  },
};

export const poll = {
  name: "clevertap_poll",
  description: "Poll async CleverTap result via req_id until success/fail.",
  integration: "clevertap",
  effect: "read",
  inputSchema: z.object({
    project: z.string().optional().describe("Project name; defaults to first configured project."),
    path: z.string().describe('Same path as original request (e.g. "/counts/trends.json")'),
    req_id: z.string(),
    max_attempts: z.number().min(1).max(30).optional().default(15),
    delay_ms: z.number().min(500).max(10000).optional().default(3000),
  }),
  handler: async (ctx: any, args: any) => {
    const { project, path, req_id, max_attempts = 15, delay_ms = 3000 } = args as any;
    const client = new CleverTapClient(await resolveProject(ctx, project));
    let result: Record<string, unknown> = { status: "partial", req_id };
    let attempts = 0;
    while (result.status === "partial" && attempts < max_attempts) {
      await new Promise((r) => setTimeout(r, delay_ms));
      result = await client.get<Record<string, unknown>>(path, { req_id });
      attempts++;
    }
    return result;
  },
};

import { z } from "zod";

// ---------------------------------------------------------------------------
// NerdGraph plumbing
//
// Every New Relic tool here speaks NerdGraph, New Relic's single GraphQL API.
// The user API key rides in the `Api-Key` header (set by ctx.http from the
// apikey manifest), and the endpoint is region-scoped — chosen from the
// `region` field captured at connect time and read back via ctx.getConfig().
// ---------------------------------------------------------------------------

const ENDPOINTS: Record<string, string> = {
  US: "https://api.newrelic.com/graphql",
  EU: "https://api.eu.newrelic.com/graphql",
};

function endpoint(ctx: any): string {
  const region = String(ctx.getConfig().region ?? "US").toUpperCase();
  return ENDPOINTS[region] ?? ENDPOINTS.US;
}

// Resolve the account id for a call: an explicit arg wins, else fall back to
// the `accountId` captured at connect time (ctx.getConfig()). Throws when
// neither is set — the meta-tool executor turns the throw into an { error }
// result the agent can read.
function resolveAccountId(ctx: any, args: any): number {
  const raw = args.accountId ?? ctx.getConfig().accountId;
  if (raw == null || raw === "") {
    throw new Error(
      "No account id: pass accountId, or set a Default Account ID when connecting New Relic."
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid accountId: ${raw}`);
  return n;
}

// POST a query/mutation. Surfaces GraphQL `errors` as a plain object so the
// agent sees the failure instead of a silent null payload.
async function nerdgraph(
  ctx: any,
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const res = await ctx.http(endpoint(ctx), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  let json: any;
  try {
    json = await res.json();
  } catch {
    return { error: `NerdGraph returned non-JSON (HTTP ${res.status})` };
  }
  if (Array.isArray(json?.errors) && json.errors.length) {
    return { errors: json.errors.map((e: any) => e.message ?? String(e)) };
  }
  return json?.data ?? json;
}

// ---------------------------------------------------------------------------
// Reads — NRQL, entity search, dashboards
// ---------------------------------------------------------------------------

export const runNrql = {
  name: "newrelic_run_nrql",
  description:
    "Run an arbitrary NRQL query against an account and return the raw result rows (actor.account.nrql). Use for any read — metrics, events, counts, facets. Example: \"SELECT count(*) FROM Transaction SINCE 1 hour ago\".",
  integration: "newrelic",
  effect: "read",
  inputSchema: z.object({
    accountId: z.number().optional().describe("Account ID; falls back to the connection's Default Account ID if omitted."),
    nrql: z.string().describe("The NRQL query to execute."),
  }),
  handler: async (ctx: any, args: any) => {
    const query = `
      query($accountId: Int!, $nrql: Nrql!) {
        actor {
          account(id: $accountId) {
            nrql(query: $nrql) { results metadata { eventTypes facets messages } }
          }
        }
      }`;
    const data: any = await nerdgraph(ctx, query, { accountId: resolveAccountId(ctx, args), nrql: args.nrql });
    // Unwrap the deep actor.account.nrql nesting to the useful payload.
    return data?.actor?.account?.nrql ?? data;
  },
};

export const searchEntities = {
  name: "newrelic_search_entities",
  description:
    "Find New Relic entities (apps, hosts, dashboards, etc.) by name/domain/type via entitySearch. Returns slim rows { guid, name, type, entityType, domain }. Use to discover an entity's GUID before fetching or tagging it — e.g. type='DASHBOARD' to locate a dashboard's GUID.",
  integration: "newrelic",
  effect: "read",
  inputSchema: z.object({
    name: z.string().optional().describe("Substring match on the entity name."),
    domain: z
      .enum(["APM", "BROWSER", "INFRA", "MOBILE", "SYNTH", "VIZ", "EXT", "AIOPS", "NR1"])
      .optional()
      .describe("Entity domain filter, e.g. VIZ for dashboards."),
    type: z
      .string()
      .optional()
      .describe("Entity type filter, e.g. DASHBOARD, APPLICATION, HOST, MONITOR."),
    query: z
      .string()
      .optional()
      .describe("Raw entitySearch query (overrides name/domain/type), e.g. \"name LIKE '%api%' AND type='DASHBOARD'\"."),
    limit: z.number().default(25),
  }),
  handler: async (ctx: any, args: any) => {
    // Build the entitySearch query string from the helpers unless a raw query
    // was supplied. New Relic ANDs the clauses.
    let searchQuery = args.query;
    if (!searchQuery) {
      const clauses: string[] = [];
      // entitySearch's query language has no backslash escaping; the safe move
      // for a quote inside the LIKE literal is to drop it (the name still rides
      // in a GraphQL variable, so this is about the inner parser, not injection).
      if (args.name) clauses.push(`name LIKE '%${String(args.name).replace(/'/g, "")}%'`);
      if (args.domain) clauses.push(`domain = '${args.domain}'`);
      if (args.type) clauses.push(`type = '${args.type}'`);
      searchQuery = clauses.join(" AND ");
    }
    if (!searchQuery) return { error: "Provide name, domain, type, or a raw query." };
    const query = `
      query($searchQuery: String!) {
        actor {
          entitySearch(query: $searchQuery) {
            count
            results {
              entities { guid name type entityType domain }
            }
          }
        }
      }`;
    const data: any = await nerdgraph(ctx, query, { searchQuery });
    const search = data?.actor?.entitySearch;
    if (!search) return data;
    const entities = (search.results?.entities ?? []).slice(0, args.limit ?? 25);
    return { count: search.count, entities };
  },
};

export const getDashboard = {
  name: "newrelic_get_dashboard",
  description:
    "Fetch a dashboard by its entity GUID, including its pages and the widgets on each page (actor.entity → DashboardEntity). Use newrelic_search_entities (type='DASHBOARD') first to find the GUID. Returns { guid, name, pages: [{ guid, name, widgets }] }.",
  integration: "newrelic",
  effect: "read",
  inputSchema: z.object({
    guid: z.string().describe("Dashboard entity GUID."),
  }),
  handler: async (ctx: any, args: any) => {
    const query = `
      query($guid: EntityGuid!) {
        actor {
          entity(guid: $guid) {
            ... on DashboardEntity {
              guid
              name
              permissions
              pages {
                guid
                name
                widgets {
                  id
                  title
                  visualization { id }
                  rawConfiguration
                }
              }
            }
          }
        }
      }`;
    const data: any = await nerdgraph(ctx, query, { guid: args.guid });
    return data?.actor?.entity ?? data;
  },
};

// ---------------------------------------------------------------------------
// Alert policies
// ---------------------------------------------------------------------------

export const createAlertPolicy = {
  name: "newrelic_create_alert_policy",
  description:
    "Create a New Relic alert policy via NerdGraph (alertsPolicyCreate). Alert policies are containers that group alert conditions and define how incidents are rolled up. incidentPreference controls grouping: PER_POLICY (one incident for the whole policy), PER_CONDITION (one per condition), or PER_CONDITION_AND_TARGET (one per condition+entity). Returns { id, name, incidentPreference }.",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    accountId: z.number().optional().describe("New Relic account ID; falls back to the connection's Default Account ID if omitted."),
    name: z.string().describe("Policy name."),
    incidentPreference: z
      .enum(["PER_POLICY", "PER_CONDITION", "PER_CONDITION_AND_TARGET"])
      .default("PER_POLICY"),
  }),
  handler: async (ctx: any, args: any) => {
    const query = `
      mutation($accountId: Int!, $policy: AlertsPolicyInput!) {
        alertsPolicyCreate(accountId: $accountId, policy: $policy) {
          id
          name
          incidentPreference
        }
      }`;
    return nerdgraph(ctx, query, {
      accountId: resolveAccountId(ctx, args),
      policy: { name: args.name, incidentPreference: args.incidentPreference ?? "PER_POLICY" },
    });
  },
};

// ---------------------------------------------------------------------------
// NRQL alert conditions
// ---------------------------------------------------------------------------

export const createStaticNrqlAlertCondition = {
  name: "newrelic_create_static_nrql_condition",
  description:
    "Create a static NRQL alert condition on a policy via NerdGraph (alertsNrqlConditionStaticCreate). Use to threshold-alert on a NRQL query's result. Supports signal-loss detection (expiration) and gap filling (signal.fillOption). Returns { id, name, enabled }.",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    accountId: z.number().optional().describe("Account ID; falls back to the connection's Default Account ID if omitted."),
    policyId: z.string().describe("ID of the policy to attach the condition to."),
    name: z.string(),
    nrql: z.string().describe("The NRQL query the condition evaluates, e.g. \"SELECT count(*) FROM Transaction WHERE error IS true\"."),
    enabled: z.boolean().default(true),
    // Threshold term.
    threshold: z.number().describe("Threshold value the term compares against."),
    operator: z
      .enum(["ABOVE", "ABOVE_OR_EQUALS", "BELOW", "BELOW_OR_EQUALS", "EQUALS", "NOT_EQUALS"])
      .default("ABOVE"),
    priority: z.enum(["CRITICAL", "WARNING"]).default("CRITICAL"),
    thresholdDuration: z
      .number()
      .default(300)
      .describe("Seconds the signal must breach before opening an incident (must be a multiple of the aggregation window)."),
    thresholdOccurrences: z.enum(["ALL", "AT_LEAST_ONCE"]).default("ALL"),
    // Signal shaping.
    aggregationWindow: z.number().default(60).describe("Aggregation window in seconds."),
    aggregationMethod: z.enum(["EVENT_FLOW", "EVENT_TIMER", "CADENCE"]).default("EVENT_FLOW"),
    aggregationDelay: z.number().default(120).describe("Seconds to wait for late data; EVENT_FLOW/CADENCE only (ignored for EVENT_TIMER)."),
    aggregationTimer: z.number().default(60).describe("Seconds to wait after the window closes before evaluating; EVENT_TIMER only (ignored otherwise)."),
    fillOption: z.enum(["NONE", "LAST_VALUE", "STATIC"]).default("NONE").describe("Gap-fill strategy."),
    fillValue: z.number().optional().describe("Value used when fillOption=STATIC."),
    // Signal-loss detection.
    expirationDuration: z
      .number()
      .optional()
      .describe("Seconds of signal loss before action; enables loss-of-signal detection when set."),
    openViolationOnExpiration: z.boolean().default(false),
    closeViolationsOnExpiration: z.boolean().default(false),
  }),
  handler: async (ctx: any, args: any) => {
    // NerdGraph's signal block takes a different late-data field per method:
    // EVENT_FLOW/CADENCE use aggregationDelay, EVENT_TIMER uses aggregationTimer.
    // Sending the wrong one fails NR validation, so emit only the matching field.
    const aggregationMethod = args.aggregationMethod ?? "EVENT_FLOW";
    const signal: any = {
      aggregationWindow: args.aggregationWindow ?? 60,
      aggregationMethod,
      fillOption: args.fillOption ?? "NONE",
      ...(args.fillValue != null ? { fillValue: args.fillValue } : {}),
    };
    if (aggregationMethod === "EVENT_TIMER") {
      signal.aggregationTimer = args.aggregationTimer ?? 60;
    } else {
      signal.aggregationDelay = args.aggregationDelay ?? 120;
    }
    const condition: any = {
      name: args.name,
      enabled: args.enabled ?? true,
      nrql: { query: args.nrql },
      terms: [
        {
          threshold: args.threshold,
          operator: args.operator ?? "ABOVE",
          priority: args.priority ?? "CRITICAL",
          thresholdDuration: args.thresholdDuration ?? 300,
          thresholdOccurrences: args.thresholdOccurrences ?? "ALL",
        },
      ],
      signal,
    };
    if (args.expirationDuration != null) {
      condition.expiration = {
        expirationDuration: args.expirationDuration,
        openViolationOnExpiration: args.openViolationOnExpiration ?? false,
        closeViolationsOnExpiration: args.closeViolationsOnExpiration ?? false,
      };
    }
    const query = `
      mutation($accountId: Int!, $policyId: ID!, $condition: AlertsNrqlConditionStaticInput!) {
        alertsNrqlConditionStaticCreate(accountId: $accountId, policyId: $policyId, condition: $condition) {
          id
          name
          enabled
        }
      }`;
    return nerdgraph(ctx, query, {
      accountId: resolveAccountId(ctx, args),
      policyId: args.policyId,
      condition,
    });
  },
};

// ---------------------------------------------------------------------------
// Legacy alert notification channels
// ---------------------------------------------------------------------------

export const createAlertNotificationChannel = {
  name: "newrelic_create_alert_notification_channel",
  description:
    "Register a (legacy) alert notification channel — an endpoint such as email or webhook that alert policies can notify. Returns the created channel { id, name, type }. Note: New Relic recommends the AI Notifications destinations/channels (newrelic_create_ai_notifications_*) for new setups; legacy channels remain for existing policies.",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    accountId: z.number().optional().describe("Account ID; falls back to the connection's Default Account ID if omitted."),
    name: z.string(),
    type: z
      .enum(["EMAIL", "WEBHOOK", "SLACK", "PAGERDUTY", "OPSGENIE", "VICTOROPS", "XMATTERS"])
      .describe("Channel type."),
    // Channel-type-specific config, e.g. { email: { emails: [...] } } or
    // { webhook: { baseUrl: "..." } }. Passed through to AlertsNotificationChannelInput.
    config: z.record(z.any()).describe("Type-specific configuration object."),
  }),
  handler: async (ctx: any, args: any) => {
    const query = `
      mutation($accountId: Int!, $notificationChannel: AlertsNotificationChannelCreateInput!) {
        alertsNotificationChannelCreate(accountId: $accountId, notificationChannel: $notificationChannel) {
          notificationChannel { id name type }
          error { description errorType }
        }
      }`;
    return nerdgraph(ctx, query, {
      accountId: resolveAccountId(ctx, args),
      notificationChannel: { name: args.name, type: args.type, ...args.config },
    });
  },
};

export const addNotificationChannelsToPolicy = {
  name: "newrelic_add_notification_channels_to_policy",
  description:
    "Associate existing (legacy) notification channels with an alert policy so it sends notifications when incidents open (alertsNotificationChannelsAddToPolicy). Provide the policy ID and one or more channel IDs.",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    accountId: z.number().optional().describe("Account ID; falls back to the connection's Default Account ID if omitted."),
    policyId: z.string(),
    notificationChannelIds: z.array(z.string()).min(1).describe("Channel IDs to attach."),
  }),
  handler: async (ctx: any, args: any) => {
    const query = `
      mutation($accountId: Int!, $policyId: ID!, $notificationChannelIds: [ID!]!) {
        alertsNotificationChannelsAddToPolicy(
          accountId: $accountId
          policyId: $policyId
          notificationChannelIds: $notificationChannelIds
        ) {
          notificationChannels { id name type }
          errors { description errorType notificationChannelId }
        }
      }`;
    return nerdgraph(ctx, query, {
      accountId: resolveAccountId(ctx, args),
      policyId: args.policyId,
      notificationChannelIds: args.notificationChannelIds,
    });
  },
};

// ---------------------------------------------------------------------------
// AI / Applied Intelligence notifications
// ---------------------------------------------------------------------------

export const createAiNotificationsDestination = {
  name: "newrelic_create_ai_notifications_destination",
  description:
    "Create an AI Notifications destination — the endpoint config for a service like Jira, ServiceNow, Slack, email, or webhook (aiNotificationsCreateDestination). A destination is the prerequisite for an AI Notifications channel. Returns the created destination { id, name, type }.",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    accountId: z.number().optional().describe("Account ID; falls back to the connection's Default Account ID if omitted."),
    name: z.string(),
    type: z
      .enum([
        "EMAIL",
        "WEBHOOK",
        "SLACK",
        "SLACK_LEGACY",
        "JIRA",
        "SERVICE_NOW",
        "PAGERDUTY_ACCOUNT_INTEGRATION",
        "PAGERDUTY_SERVICE_INTEGRATION",
        "MOBILE_PUSH",
        "EVENT_BRIDGE",
      ])
      .describe("Destination type."),
    properties: z
      .array(z.object({ key: z.string(), value: z.string() }))
      .default([])
      .describe("Destination properties, e.g. [{ key: 'url', value: 'https://...' }]."),
    auth: z
      .record(z.any())
      .optional()
      .describe("Optional auth block, e.g. { type: 'BASIC', basic: { user, password } } or { type: 'TOKEN', token: {...} }."),
  }),
  handler: async (ctx: any, args: any) => {
    const destination: any = {
      name: args.name,
      type: args.type,
      properties: args.properties ?? [],
    };
    if (args.auth) destination.auth = args.auth;
    const query = `
      mutation($accountId: Int!, $destination: AiNotificationsDestinationInput!) {
        aiNotificationsCreateDestination(accountId: $accountId, destination: $destination) {
          destination { id name type active }
          error { ... on AiNotificationsConstraintsError { constraints { name } } }
          errors { description type }
        }
      }`;
    return nerdgraph(ctx, query, { accountId: resolveAccountId(ctx, args), destination });
  },
};

export const createAiNotificationsChannel = {
  name: "newrelic_create_ai_notifications_channel",
  description:
    "Create an AI Notifications channel bound to an existing destination (aiNotificationsCreateChannel). The channel shapes what gets sent (subject, payload) for a destination. Requires a destinationId from newrelic_create_ai_notifications_destination. Returns the created channel { id, name }.",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    accountId: z.number().optional().describe("Account ID; falls back to the connection's Default Account ID if omitted."),
    name: z.string(),
    type: z
      .enum([
        "EMAIL",
        "WEBHOOK",
        "SLACK",
        "SLACK_LEGACY",
        "JIRA_CLASSIC",
        "JIRA_NEXTGEN",
        "SERVICENOW_INCIDENTS",
        "PAGERDUTY_ACCOUNT_INTEGRATION",
        "PAGERDUTY_SERVICE_INTEGRATION",
        "MOBILE_PUSH",
        "EVENT_BRIDGE",
      ])
      .describe("Channel type (must be compatible with the destination type)."),
    destinationId: z.string().describe("ID of the destination this channel sends through."),
    product: z
      .enum(["IINT", "ERROR_TRACKING", "DISCUSSIONS", "NTFC", "SHARING", "PD"])
      .default("IINT")
      .describe("New Relic product the channel serves; IINT = Incident Intelligence/Workflows."),
    properties: z
      .array(z.object({ key: z.string(), value: z.string() }))
      .default([])
      .describe("Channel properties, e.g. payload/subject templates."),
  }),
  handler: async (ctx: any, args: any) => {
    const channel = {
      name: args.name,
      type: args.type,
      destinationId: args.destinationId,
      product: args.product ?? "IINT",
      properties: args.properties ?? [],
    };
    const query = `
      mutation($accountId: Int!, $channel: AiNotificationsChannelInput!) {
        aiNotificationsCreateChannel(accountId: $accountId, channel: $channel) {
          channel { id name type }
          error { ... on AiNotificationsConstraintsError { constraints { name } } }
          errors { description type }
        }
      }`;
    return nerdgraph(ctx, query, { accountId: resolveAccountId(ctx, args), channel });
  },
};

export const createAiWorkflow = {
  name: "newrelic_create_ai_workflow",
  description:
    "Create an AI workflow for automated incident response (aiWorkflowsCreateWorkflow). A workflow connects an issue filter (predicates over issue attributes) to notification channels, with optional NRQL enrichments. Provide channel IDs (from newrelic_create_ai_notifications_channel) and filter predicates. Returns the created workflow { id, name }.",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    accountId: z.number().optional().describe("Account ID; falls back to the connection's Default Account ID if omitted."),
    name: z.string(),
    channelIds: z.array(z.string()).min(1).describe("Notification channel IDs the workflow routes issues to."),
    notificationTrigger: z
      .enum(["ACTIVATED", "ACKNOWLEDGED", "CLOSED", "PRIORITY_CHANGED", "OTHER_UPDATES"])
      .default("ACTIVATED")
      .describe("When the destination is notified."),
    filterName: z.string().default("filter").describe("Name for the issues filter."),
    predicates: z
      .array(
        z.object({
          attribute: z.string().describe("Issue attribute, e.g. 'labels.policyIds' or 'accumulations.tag.team'."),
          operator: z.enum([
            "CONTAINS",
            "DOES_NOT_CONTAIN",
            "DOES_NOT_EQUAL",
            "ENDS_WITH",
            "EQUAL",
            "EXACTLY_MATCHES",
            "GREATER_OR_EQUAL",
            "GREATER_THAN",
            "IS",
            "IS_NOT",
            "LESS_OR_EQUAL",
            "LESS_THAN",
            "STARTS_WITH",
          ]),
          values: z.array(z.string()),
        })
      )
      .min(1)
      .describe("Filter predicates ANDed together to decide which issues the workflow handles."),
    workflowEnabled: z.boolean().default(true),
    mutingRulesHandling: z
      .enum(["DONT_NOTIFY_FULLY_MUTED_ISSUES", "DONT_NOTIFY_FULLY_OR_PARTIALLY_MUTED_ISSUES", "NOTIFY_ALL_ISSUES"])
      .default("NOTIFY_ALL_ISSUES"),
    enrichments: z
      .record(z.any())
      .optional()
      .describe("Optional enrichments block, e.g. { nrqlConfigurations: [{ name, configuration: [{ query }] }] }."),
  }),
  handler: async (ctx: any, args: any) => {
    const createWorkflowData: any = {
      name: args.name,
      workflowEnabled: args.workflowEnabled ?? true,
      mutingRulesHandling: args.mutingRulesHandling ?? "NOTIFY_ALL_ISSUES",
      destinationConfigurations: args.channelIds.map((channelId: string) => ({
        channelId,
        notificationTriggers: [args.notificationTrigger ?? "ACTIVATED"],
      })),
      issuesFilter: {
        name: args.filterName ?? "filter",
        type: "FILTER",
        predicates: args.predicates,
      },
      enrichmentsEnabled: !!args.enrichments,
      destinationsEnabled: true,
    };
    if (args.enrichments) createWorkflowData.enrichments = args.enrichments;
    const query = `
      mutation($accountId: Int!, $createWorkflowData: AiWorkflowsCreateWorkflowInput!) {
        aiWorkflowsCreateWorkflow(accountId: $accountId, createWorkflowData: $createWorkflowData) {
          workflow { id name workflowEnabled }
          errors { description type }
        }
      }`;
    return nerdgraph(ctx, query, { accountId: resolveAccountId(ctx, args), createWorkflowData });
  },
};

// ---------------------------------------------------------------------------
// Entities & tagging
// ---------------------------------------------------------------------------

export const addTagsToEntity = {
  name: "newrelic_add_tags_to_entity",
  description:
    "Add tags (key + values) to a New Relic entity for filtering and organization (taggingAddTagsToEntity). Identify the entity by its GUID. Note: for APM agents a restart may be required before new tags appear. Returns { errors } (empty on success).",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    guid: z.string().describe("Entity GUID (the base64-ish entity identifier)."),
    tags: z
      .array(z.object({ key: z.string(), values: z.array(z.string()).min(1) }))
      .min(1)
      .describe("Tags to add, e.g. [{ key: 'team', values: ['payments'] }]."),
  }),
  handler: async (ctx: any, args: any) => {
    const query = `
      mutation($guid: EntityGuid!, $tags: [TaggingTagInput!]!) {
        taggingAddTagsToEntity(guid: $guid, tags: $tags) {
          errors { message type }
        }
      }`;
    return nerdgraph(ctx, query, { guid: args.guid, tags: args.tags });
  },
};

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export const addWidgetsToDashboardPage = {
  name: "newrelic_add_widgets_to_dashboard_page",
  description:
    "Add visualization widgets (line/area/bar/billboard/table, etc.) to an existing dashboard page (dashboardAddWidgetsToPage). Identify the page by its GUID. Each widget carries a visualization id, a grid layout (column/row are 1-based), and NRQL queries. Returns { errors } (empty on success).",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    pageGuid: z.string().describe("GUID of the dashboard page to add widgets to."),
    widgets: z
      .array(
        z.object({
          title: z.string(),
          visualizationId: z
            .string()
            .default("viz.line")
            .describe("Visualization id, e.g. viz.line, viz.area, viz.bar, viz.billboard, viz.table, viz.pie."),
          column: z.number().default(1).describe("1-based grid column (1–12)."),
          row: z.number().default(1).describe("1-based grid row."),
          width: z.number().default(4).describe("Width in grid columns (1–12)."),
          height: z.number().default(3).describe("Height in grid rows."),
          nrqlQueries: z
            .array(z.object({ accountId: z.number(), query: z.string() }))
            .min(1)
            .describe("One or more NRQL queries powering the widget."),
        })
      )
      .min(1),
  }),
  handler: async (ctx: any, args: any) => {
    const widgets = args.widgets.map((w: any) => ({
      title: w.title,
      visualization: { id: w.visualizationId ?? "viz.line" },
      layout: {
        column: w.column ?? 1,
        row: w.row ?? 1,
        width: w.width ?? 4,
        height: w.height ?? 3,
      },
      rawConfiguration: {
        nrqlQueries: w.nrqlQueries.map((q: any) => ({ accountId: q.accountId, query: q.query })),
      },
    }));
    const query = `
      mutation($guid: EntityGuid!, $widgets: [DashboardWidgetInput!]!) {
        dashboardAddWidgetsToPage(guid: $guid, widgets: $widgets) {
          errors { description type }
        }
      }`;
    return nerdgraph(ctx, query, { guid: args.pageGuid, widgets });
  },
};

// ---------------------------------------------------------------------------
// Cloud integrations
// ---------------------------------------------------------------------------

export const configureCloudIntegration = {
  name: "newrelic_configure_cloud_integration",
  description:
    "Enable and configure a cloud integration (AWS/Azure/GCP) for monitoring (cloudConfigureIntegration). The cloud account must already be linked to New Relic. The `integrations` object is provider-shaped and keyed by provider+service, e.g. { aws: { ec2: [{ linkedAccountId, metricsPollingInterval }] } }. Returns configured integrations and any errors.",
  integration: "newrelic",
  effect: "write",
  inputSchema: z.object({
    accountId: z.number().optional().describe("Account ID; falls back to the connection's Default Account ID if omitted."),
    integrations: z
      .record(z.any())
      .describe("Provider-keyed integrations config, e.g. { aws: { ec2: [{ linkedAccountId: 123 }] } }."),
  }),
  handler: async (ctx: any, args: any) => {
    const query = `
      mutation($accountId: Int!, $integrations: CloudIntegrationsInput!) {
        cloudConfigureIntegration(accountId: $accountId, integrations: $integrations) {
          integrations { id name service { slug } }
          errors { message type linkedAccountId nrAccountId }
        }
      }`;
    return nerdgraph(ctx, query, { accountId: resolveAccountId(ctx, args), integrations: args.integrations });
  },
};

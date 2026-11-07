import { z } from "zod";

// Slim row for event lists — drops etags, conferenceData, reminders, raw
// attendee objects, creator/organizer blobs (live-measured: raw events are
// ~10x this size). start/end collapse dateTime|date into one string.
function slimEventRow(e: any) {
  return {
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    location: e.location,
    status: e.status,
    organizer: e.organizer?.email,
    attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
    htmlLink: e.htmlLink,
  };
}

// Fuller (but still slim) shape for single-event reads and create/update
// results: adds description (truncated to 1000 chars) and per-attendee
// email + responseStatus.
function slimEventDetail(e: any) {
  const description =
    typeof e.description === "string" && e.description.length > 1000
      ? e.description.slice(0, 1000)
      : e.description;
  return {
    ...slimEventRow(e),
    description,
    attendees: Array.isArray(e.attendees)
      ? e.attendees.map((a: any) => ({ email: a.email, responseStatus: a.responseStatus }))
      : [],
  };
}

export const listEvents = {
  name: "google_calendar_list_events",
  description:
    "List events on a calendar (default \"primary\", max default 10). Returns slim rows { id, summary, start, end, location, status, organizer, attendees (count), htmlLink } plus nextPageToken for paging — use google_calendar_get_event for description and per-attendee status. Pass timeMin (ISO 8601) to skip past events.",
  integration: "google-calendar",
  effect: "read",
  inputSchema: z.object({
    calendarId: z.string().default("primary"),
    maxResults: z.number().default(10),
    timeMin: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("maxResults", String(args.maxResults));
    if (args.timeMin) params.set("timeMin", args.timeMin);

    const res = await ctx.http(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendarId)}/events?${params}`
    );
    const data = await res.json();
    const out: any = { events: (data.items ?? []).map(slimEventRow) };
    if (data.nextPageToken) out.nextPageToken = data.nextPageToken;
    return out;
  },
};

export const createEvent = {
  name: "google_calendar_create_event",
  description:
    "Create an event on a calendar (default \"primary\"). Check availability with google_calendar_freebusy BEFORE creating to avoid double-booking. start/end take { dateTime } in ISO 8601 with offset (e.g. \"2026-06-12T15:00:00+07:00\"). Returns the created event in slim form ({ id, summary, start, end, ... }).",
  integration: "google-calendar",
  effect: "write",
  inputSchema: z.object({
    calendarId: z.string().default("primary"),
    summary: z.string(),
    start: z.object({ dateTime: z.string() }),
    end: z.object({ dateTime: z.string() }),
    description: z.string().optional(),
    attendees: z.array(z.object({ email: z.string() })).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { calendarId, ...body } = args;
    const res = await ctx.http(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    return slimEventDetail(await res.json());
  },
};

export const getEvent = {
  name: "google_calendar_get_event",
  description:
    "Get one calendar event by id. Returns the slim detail shape: { id, summary, start, end, location, status, organizer, htmlLink, description (truncated to 1000 chars), attendees: [{ email, responseStatus }] }. Get event ids from google_calendar_list_events.",
  integration: "google-calendar",
  effect: "read",
  inputSchema: z.object({
    calendarId: z.string().default("primary"),
    eventId: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendarId)}/events/${args.eventId}`
    );
    return slimEventDetail(await res.json());
  },
};

export const updateEvent = {
  name: "google_calendar_update_event",
  description:
    "Update fields of an existing event (PATCH — only the fields you pass change). Returns the updated event in the same slim shape as google_calendar_get_event. To remove an event entirely use google_calendar_delete_event.",
  integration: "google-calendar",
  effect: "write",
  inputSchema: z.object({
    calendarId: z.string().default("primary"),
    eventId: z.string(),
    summary: z.string().optional(),
    start: z.object({ dateTime: z.string() }).optional(),
    end: z.object({ dateTime: z.string() }).optional(),
    description: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { calendarId, eventId, ...body } = args;
    const res = await ctx.http(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    return slimEventDetail(await res.json());
  },
};

export const deleteEvent = {
  name: "google_calendar_delete_event",
  description:
    "Delete a calendar event permanently (attendees are notified per calendar settings). Returns { success: true } on success. To merely change time/details, use google_calendar_update_event instead.",
  integration: "google-calendar",
  effect: "destructive",
  inputSchema: z.object({
    calendarId: z.string().default("primary"),
    eventId: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendarId)}/events/${args.eventId}`,
      { method: "DELETE" }
    );
    if (res.status === 204) return { success: true };
    return res.json();
  },
};

export const listCalendars = {
  name: "google_calendar_list_calendars",
  description:
    "List the user's calendars (default 10). Returns slim rows { id, summary, primary, accessRole, timeZone } — use the id as calendarId in the other calendar tools (\"primary\" also works for the main calendar).",
  integration: "google-calendar",
  effect: "read",
  inputSchema: z.object({
    maxResults: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("maxResults", String(args.maxResults));
    const res = await ctx.http(`https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`);
    const data = await res.json();
    return {
      calendars: (data.items ?? []).map((c: any) => ({
        id: c.id,
        summary: c.summary,
        primary: Boolean(c.primary),
        accessRole: c.accessRole,
        timeZone: c.timeZone,
      })),
    };
  },
};

export const freeBusy = {
  name: "google_calendar_freebusy",
  description:
    "Check when calendars are busy between timeMin and timeMax (ISO 8601) — use this BEFORE google_calendar_create_event to pick a free slot and avoid double-booking. calendarIds defaults to [\"primary\"]. Returns { calendars: { <id>: [{ start, end }, ...] } } where each array is the busy intervals (empty array = fully free).",
  integration: "google-calendar",
  effect: "read",
  inputSchema: z.object({
    timeMin: z.string(),
    timeMax: z.string(),
    calendarIds: z.array(z.string()).default(["primary"]),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        items: args.calendarIds.map((id: string) => ({ id })),
      }),
    });
    const data = await res.json();
    const calendars: Record<string, Array<{ start: string; end: string }>> = {};
    for (const [id, cal] of Object.entries<any>(data.calendars ?? {})) {
      calendars[id] = (cal.busy ?? []).map((b: any) => ({ start: b.start, end: b.end }));
    }
    return { calendars };
  },
};

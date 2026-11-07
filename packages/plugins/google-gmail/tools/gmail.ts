import { z } from "zod";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Case-insensitive header lookup over Gmail's payload.headers array. */
function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value;
}

/** Ensure an RFC 2822 message-id is angle-bracket wrapped. */
function angleWrap(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

/** Depth-first walk of payload.parts for the first text/plain part; base64url-decode it. */
function extractPlainText(payload: any): string | undefined {
  if (!payload) return undefined;
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text !== undefined) return text;
  }
  return undefined;
}

export const sendEmail = {
  name: "google_gmail_send",
  description:
    "Send an email, or reply within an existing conversation. To reply in-thread you must pass BOTH " +
    "threadId (from google_gmail_list/google_gmail_get) AND inReplyTo (the Message-ID header value " +
    "returned as messageIdHeader by google_gmail_get) — threadId keeps it in the Gmail thread, " +
    "inReplyTo sets the In-Reply-To/References MIME headers so recipients' clients thread it too. " +
    "Omit both to start a new conversation. Returns the sent message's {id, threadId, labelIds}.",
  integration: "google-gmail",
  effect: "destructive",
  inputSchema: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
    cc: z.string().email().optional(),
    bcc: z.string().email().optional(),
    threadId: z
      .string()
      .optional()
      .describe("Gmail thread to reply into (from google_gmail_list or google_gmail_get)"),
    inReplyTo: z
      .string()
      .optional()
      .describe("Message-ID header value of the message being replied to (messageIdHeader from google_gmail_get)"),
  }),
  handler: async (ctx: any, args: any) => {
    const lines = [`To: ${args.to}`];
    if (args.cc) lines.push(`Cc: ${args.cc}`);
    if (args.bcc) lines.push(`Bcc: ${args.bcc}`);
    lines.push(`Subject: ${args.subject}`);
    if (args.inReplyTo) {
      const ref = angleWrap(args.inReplyTo);
      lines.push(`In-Reply-To: ${ref}`);
      lines.push(`References: ${ref}`);
    }
    const raw = Buffer.from(`${lines.join("\n")}\n\n${args.body}`).toString("base64url");

    const payload: Record<string, string> = { raw };
    if (args.threadId) payload.threadId = args.threadId;

    const res = await ctx.http(`${BASE}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json();
  },
};

export const listEmails = {
  name: "google_gmail_list",
  description:
    "List messages with sender/subject/date/snippet per row — use this for scanning a mailbox; use " +
    "google_gmail_get when you need the full body or the Message-ID for a reply. Supports the full " +
    "Gmail search syntax via `query` (e.g. \"is:unread from:alice@example.com newer_than:7d\"). " +
    "Returns rows of {id, threadId, from, subject, date, snippet, labelIds} plus nextPageToken. " +
    "maxResults defaults to 10 and is capped at 25, because each row costs one metadata fetch.",
  integration: "google-gmail",
  effect: "read",
  inputSchema: z.object({
    maxResults: z.number().default(10).describe("Max messages to return (default 10, capped at 25)"),
    query: z.string().optional().describe("Gmail search query, e.g. \"is:unread from:alice newer_than:7d\""),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("maxResults", String(Math.min(args.maxResults ?? 10, 25)));
    if (args.query) params.set("q", args.query);

    const listRes = await ctx.http(`${BASE}/messages?${params}`);
    const list = await listRes.json();
    const ids: Array<{ id: string }> = list.messages ?? [];

    const messages = await Promise.all(
      ids.map(async (m) => {
        const res = await ctx.http(
          `${BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
        );
        const msg = await res.json();
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: header(msg.payload?.headers, "From"),
          subject: header(msg.payload?.headers, "Subject"),
          date: header(msg.payload?.headers, "Date"),
          snippet: msg.snippet,
          labelIds: msg.labelIds,
        };
      })
    );

    return { messages, nextPageToken: list.nextPageToken };
  },
};

export const getEmail = {
  name: "google_gmail_get",
  description:
    "Read one message in full: decoded plain-text body plus from/to/subject/date and messageIdHeader " +
    "(the Message-ID header — pass it as inReplyTo to google_gmail_send, together with threadId, to " +
    "reply in-thread). Returns {id, threadId, from, to, subject, date, messageIdHeader, body, labelIds}; " +
    "body falls back to the snippet when no text/plain part exists. Set raw=true only if you need the " +
    "unshaped Gmail API payload (large; includes the full MIME tree).",
  integration: "google-gmail",
  effect: "read",
  inputSchema: z.object({
    id: z.string(),
    raw: z.boolean().default(false).describe("Return the raw Gmail API message payload instead of the shaped summary"),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${BASE}/messages/${args.id}`);
    const msg = await res.json();
    if (args.raw) return msg;

    const headers = msg.payload?.headers;
    return {
      id: msg.id,
      threadId: msg.threadId,
      from: header(headers, "From"),
      to: header(headers, "To"),
      subject: header(headers, "Subject"),
      date: header(headers, "Date"),
      messageIdHeader: header(headers, "Message-ID") ?? header(headers, "Message-Id"),
      body: extractPlainText(msg.payload) ?? msg.snippet,
      labelIds: msg.labelIds,
    };
  },
};

export const modifyEmail = {
  name: "google_gmail_modify",
  description:
    "Change a message's labels: mark read/unread, archive, or add/remove arbitrary label IDs (from " +
    "google_gmail_labels). Convenience flags: markRead=true removes UNREAD, archive=true removes INBOX " +
    "— they merge with any explicit addLabelIds/removeLabelIds. Returns the message's {id, labelIds} " +
    "after the change. Use after processing mail from google_gmail_list so the same messages don't " +
    "show up as unread next scan.",
  integration: "google-gmail",
  effect: "destructive",
  inputSchema: z.object({
    messageId: z.string(),
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add (see google_gmail_labels)"),
    removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
    markRead: z.boolean().optional().describe("Convenience: remove the UNREAD label"),
    archive: z.boolean().optional().describe("Convenience: remove the INBOX label (archives the message)"),
  }),
  handler: async (ctx: any, args: any) => {
    const addLabelIds: string[] = [...(args.addLabelIds ?? [])];
    const removeLabelIds: string[] = [...(args.removeLabelIds ?? [])];
    if (args.markRead && !removeLabelIds.includes("UNREAD")) removeLabelIds.push("UNREAD");
    if (args.archive && !removeLabelIds.includes("INBOX")) removeLabelIds.push("INBOX");

    const res = await ctx.http(`${BASE}/messages/${args.messageId}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
    const msg = await res.json();
    return { id: msg.id, labelIds: msg.labelIds };
  },
};

export const getProfile = {
  name: "google_gmail_profile",
  description:
    "Get the connected account's profile: {emailAddress, messagesTotal, threadsTotal, historyId}. " +
    "Use to confirm which mailbox you're acting on before sending or modifying mail.",
  integration: "google-gmail",
  effect: "read",
  inputSchema: z.object({}),
  handler: async (ctx: any, _args: any) => {
    const res = await ctx.http(`${BASE}/profile`);
    return res.json();
  },
};

export const listLabels = {
  name: "google_gmail_labels",
  description:
    "List all label IDs and names (system labels like INBOX/UNREAD/STARRED plus user labels). " +
    "Use to find label IDs for google_gmail_modify or `label:` clauses in google_gmail_list queries.",
  integration: "google-gmail",
  effect: "read",
  inputSchema: z.object({}),
  handler: async (ctx: any, _args: any) => {
    const res = await ctx.http(`${BASE}/labels`);
    return res.json();
  },
};

export const listThreads = {
  name: "google_gmail_threads",
  description:
    "List conversation threads as {id, snippet, historyId} rows plus nextPageToken — one row per " +
    "conversation, so prefer this over google_gmail_list when back-and-forth replies would flood the " +
    "message list. Supports Gmail search syntax via `query`; maxResults defaults to 10. Pass a thread " +
    "id as threadId to google_gmail_send to reply into the conversation.",
  integration: "google-gmail",
  effect: "read",
  inputSchema: z.object({
    maxResults: z.number().default(10).describe("Max threads to return (default 10)"),
    query: z.string().optional().describe("Gmail search query, e.g. \"is:unread from:alice\""),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("maxResults", String(args.maxResults));
    if (args.query) params.set("q", args.query);
    const res = await ctx.http(`${BASE}/threads?${params}`);
    const data = await res.json();
    const threads = (data.threads ?? []).map((t: any) => ({
      id: t.id,
      snippet: t.snippet,
      historyId: t.historyId,
    }));
    return { threads, nextPageToken: data.nextPageToken };
  },
};

export const createDraft = {
  name: "google_gmail_draft",
  description:
    "Create a draft (saved to the Drafts folder, NOT sent — use google_gmail_send to actually send). " +
    "Use when the user should review/edit before sending. Returns the draft's {id, message}.",
  integration: "google-gmail",
  effect: "write",
  inputSchema: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
    cc: z.string().email().optional(),
    bcc: z.string().email().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const raw = Buffer.from(
      `To: ${args.to}\nSubject: ${args.subject}\n${args.cc ? `Cc: ${args.cc}\n` : ""}${args.bcc ? `Bcc: ${args.bcc}\n` : ""}\n${args.body}`
    ).toString("base64url");

    const res = await ctx.http(`${BASE}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    return res.json();
  },
};

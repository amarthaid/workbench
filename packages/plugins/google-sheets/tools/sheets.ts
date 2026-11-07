import { z } from "zod";

export const readSheet = {
  name: "google_sheets_read",
  description:
    "Read cell values from a Google Sheet range (e.g. \"Sheet1!A1:C10\"). Returns { range, values } where values is a 2D array of strings — no formatting/metadata. Use google_sheets_search first if you only know the spreadsheet's name, not its ID.",
  integration: "google-sheets",
  effect: "read",
  inputSchema: z.object({
    spreadsheetId: z.string(),
    range: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}`
    );
    const data = await res.json();
    return { range: data.range, values: data.values ?? [] };
  },
};

export const writeSheet = {
  name: "google_sheets_write",
  description:
    "OVERWRITE cell values in an exact range of a Google Sheet (PUT semantics — existing cells in the range are replaced). To add new rows to the end of a log/table WITHOUT touching existing data, use google_sheets_append instead. Returns { updatedRange, updatedCells }.",
  integration: "google-sheets",
  effect: "destructive",
  inputSchema: z.object({
    spreadsheetId: z.string(),
    range: z.string(),
    values: z.array(z.array(z.string())),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: args.values }),
      }
    );
    const data = await res.json();
    return { updatedRange: data.updatedRange, updatedCells: data.updatedCells };
  },
};

export const appendSheet = {
  name: "google_sheets_append",
  description:
    "Append rows to the end of a table/log in a Google Sheet — THIS is the tool for adding new rows (Sheets finds the table in `range`, e.g. \"Sheet1!A:C\", and inserts after the last row; existing data is never overwritten). Use google_sheets_write only when you want to OVERWRITE an exact range. Values are parsed as if typed by a user (USER_ENTERED: numbers, dates, formulas). Returns { updatedRange, updatedRows }.",
  integration: "google-sheets",
  effect: "write",
  inputSchema: z.object({
    spreadsheetId: z.string(),
    range: z.string(),
    values: z.array(z.array(z.string())),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: args.values }),
      }
    );
    const data = await res.json();
    return {
      updatedRange: data.updates?.updatedRange,
      updatedRows: data.updates?.updatedRows,
    };
  },
};

export const createSpreadsheet = {
  name: "google_sheets_create",
  description:
    "Create a new (empty) Google Spreadsheet with the given title, optionally with named tabs (`sheets`, defaults to one \"Sheet1\" tab). Use google_sheets_write or google_sheets_append afterwards to put data in it.",
  integration: "google-sheets",
  effect: "write",
  inputSchema: z.object({
    title: z.string(),
    sheets: z.array(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = { properties: { title: args.title } };
    if (args.sheets) {
      body.sheets = args.sheets.map((name: string) => ({ properties: { title: name } }));
    }
    const res = await ctx.http("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

export const searchSheets = {
  name: "google_sheets_search",
  description:
    "Find Google Sheets by name (Drive name-contains match). Returns up to pageSize (default 10) rows of { id, name, modifiedTime } plus nextPageToken — use the id with google_sheets_read/write/append. For full-text or non-spreadsheet search use google_drive_search.",
  integration: "google-sheets",
  effect: "read",
  inputSchema: z.object({
    query: z.string(),
    pageSize: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    // Escape backslash + single-quote so user input can't break out of the
    // Drive `q` string literal (query injection). Drive escapes with a backslash.
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    params.set(
      "q",
      `mimeType='application/vnd.google-apps.spreadsheet' and name contains '${esc(args.query)}'`
    );
    params.set("pageSize", String(args.pageSize));
    params.set("fields", "nextPageToken,files(id,name,modifiedTime)");
    const res = await ctx.http(`https://www.googleapis.com/drive/v3/files?${params}`);
    return res.json();
  },
};

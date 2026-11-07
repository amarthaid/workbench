import { z } from "zod";

export const getPresentation = {
  name: "google_slides_get",
  description: "Get a Google Slides presentation by ID",
  integration: "google-slides",
  effect: "read",
  inputSchema: z.object({
    presentationId: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://slides.googleapis.com/v1/presentations/${args.presentationId}`
    );
    return res.json();
  },
};

export const createPresentation = {
  name: "google_slides_create",
  description: "Create a new Google Slides presentation",
  integration: "google-slides",
  effect: "write",
  inputSchema: z.object({
    title: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http("https://slides.googleapis.com/v1/presentations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: args.title }),
    });
    return res.json();
  },
};

export const batchUpdate = {
  name: "google_slides_batch_update",
  description: "Apply batch updates to a Google Slides presentation (insert text, create/delete slides, etc.)",
  integration: "google-slides",
  effect: "destructive",
  inputSchema: z.object({
    presentationId: z.string(),
    requests: z.array(z.record(z.any())),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://slides.googleapis.com/v1/presentations/${args.presentationId}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: args.requests }),
      }
    );
    return res.json();
  },
};

export const searchSlides = {
  name: "google_slides_search",
  description: "Search for Google Slides presentations in Drive",
  integration: "google-slides",
  effect: "read",
  inputSchema: z.object({
    query: z.string().optional(),
    pageSize: z.number().default(10),
    orderBy: z.string().default("modifiedTime desc"),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    // Escape backslash + single-quote so user input can't break out of the
    // Drive `q` string literal (query injection). Drive escapes with a backslash.
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = args.query
      ? `mimeType='application/vnd.google-apps.presentation' and name contains '${esc(args.query)}'`
      : "mimeType='application/vnd.google-apps.presentation'";
    params.set("q", q);
    params.set("pageSize", String(args.pageSize));
    params.set("orderBy", args.orderBy);
    params.set("fields", "nextPageToken,files(id,name,modifiedTime,webViewLink)");
    // Drive's orderBy parser rejects '+' for the space ("Invalid Value"); send %20.
    const res = await ctx.http(`https://www.googleapis.com/drive/v3/files?${params.toString().replace(/\+/g, "%20")}`);
    return res.json();
  },
};

export const createFromMarkdown = {
  name: "google_slides_create_from_markdown",
  description: "Create a Google Slides presentation from Markdown text. Use '---' to separate slides. Supports tables, bullets, quotes, and two-column layouts with '|||'.",
  integration: "google-slides",
  effect: "write",
  inputSchema: z.object({
    title: z.string(),
    markdownText: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    // Parse markdown into slide requests
    const slides = args.markdownText.split(/^---$/m).map((s: string) => s.trim()).filter(Boolean);

    // Create blank presentation
    const createRes = await ctx.http("https://slides.googleapis.com/v1/presentations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: args.title }),
    });
    const presentation = await createRes.json();
    const presentationId = presentation.presentationId;

    // Build batchUpdate requests for each slide: create a blank slide, add a
    // text box covering it, then insert that slide's markdown as the box text.
    // (BLANK layout has no placeholders, so we must create our own shape — and
    // insertText must run after the shape exists, hence the ordering here.)
    const requests: any[] = [];
    for (let i = 0; i < slides.length; i++) {
      const slideId = `slide_${i}`;
      const boxId = `tb_${i}`;
      requests.push({
        createSlide: {
          objectId: slideId,
          insertionIndex: i + 1,
          slideLayoutReference: { predefinedLayout: "BLANK" },
        },
      });
      requests.push({
        createShape: {
          objectId: boxId,
          shapeType: "TEXT_BOX",
          elementProperties: {
            pageObjectId: slideId,
            // EMU: ~7.5in wide x ~3.75in tall, inset ~0.5in from top-left.
            size: {
              width: { magnitude: 6858000, unit: "EMU" },
              height: { magnitude: 3429000, unit: "EMU" },
            },
            transform: { scaleX: 1, scaleY: 1, translateX: 457200, translateY: 457200, unit: "EMU" },
          },
        },
      });
      requests.push({
        insertText: { objectId: boxId, text: slides[i], insertionIndex: 0 },
      });
    }

    // Execute batch update
    const updateRes = await ctx.http(
      `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      }
    );

    return {
      presentationId,
      title: presentation.title,
      slidesCreated: slides.length,
      batchUpdateResult: await updateRes.json(),
    };
  },
};

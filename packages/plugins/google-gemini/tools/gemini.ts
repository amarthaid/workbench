import { z } from "zod";

export const generateContent = {
  name: "google_gemini_generate",
  description: "Generate content with Google Gemini",
  integration: "google-gemini",
  effect: "read",
  inputSchema: z.object({
    prompt: z.string(),
    model: z.string().default("gemini-1.5-flash"),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: args.prompt }] }],
        }),
      }
    );
    return res.json();
  },
};

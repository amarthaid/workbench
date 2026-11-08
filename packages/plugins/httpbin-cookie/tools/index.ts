import { z } from "zod";

export const getCookies = {
  name: "httpbin_get_cookies",
  description: "Get current cookies from httpbin",
  integration: "httpbin-cookie",
  effect: "read",
  inputSchema: z.object({}),
  handler: async (ctx: any, _args: any) => {
    const res = await ctx.http("https://httpbin.org/cookies");
    return res.json();
  },
};

export const setCookie = {
  name: "httpbin_set_cookie",
  description: "Set a cookie on httpbin",
  integration: "httpbin-cookie",
  effect: "write",
  inputSchema: z.object({
    name: z.string(),
    value: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`https://httpbin.org/cookies/set?${args.name}=${encodeURIComponent(args.value)}`, {
      redirect: "manual",
    });
    return { status: res.status, message: "Cookie set" };
  },
};

export const getHeaders = {
  name: "httpbin_get_headers",
  description: "Get request headers (useful to verify Cookie header is injected)",
  integration: "httpbin-cookie",
  effect: "read",
  inputSchema: z.object({}),
  handler: async (ctx: any, _args: any) => {
    const res = await ctx.http("https://httpbin.org/headers");
    return res.json();
  },
};

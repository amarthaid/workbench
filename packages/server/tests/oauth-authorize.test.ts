import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
    PORTAL_URL: "http://localhost:5173", SERVER_PUBLIC_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-32-chars-long!!", NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
  },
}));

import { buildAuthUrl } from "../src/auth/google";

describe("buildAuthUrl returnTicket", () => {
  it("encodes the ticket into the OAuth state", async () => {
    const url = new URL(await buildAuthUrl("ticket-abc"));
    const state = url.searchParams.get("state")!;
    expect(state).toContain("ticket-abc");
  });
});

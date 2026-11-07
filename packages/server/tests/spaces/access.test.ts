import { describe, it, expect, beforeEach } from "vitest";
import { canView } from "../../src/spaces/access";
import { getSpace, setShares, upsertSpace, type Visibility } from "../../src/spaces/store";
import { resetSpacesDb } from "./helpers";

beforeEach(resetSpacesDb);

async function space(visibility: Visibility) {
  await upsertSpace({ name: "s1", ownerId: "owner", title: "T", tools: [], visibility });
  return (await getSpace("s1"))!;
}

describe("spaces/access canView", () => {
  it("private: only the owner", async () => {
    const s = await space("private");
    expect(await canView(s, { userId: "owner", email: "owner@example.com" })).toBe(true);
    expect(await canView(s, { userId: "other", email: "dev@example.com" })).toBe(false);
  });

  it("org: any signed-in viewer", async () => {
    const s = await space("org");
    expect(await canView(s, { userId: "other", email: null })).toBe(true);
  });

  it("users: listed emails, case-insensitive", async () => {
    const s = await space("users");
    await setShares("s1", "owner", ["Dev@Example.com"]);
    expect(await canView(s, { userId: "a", email: "DEV@example.COM" })).toBe(true);
    expect(await canView(s, { userId: "b", email: "qa@example.com" })).toBe(false);
    expect(await canView(s, { userId: "c", email: null })).toBe(false);
    expect(await canView(s, { userId: "owner", email: null })).toBe(true);
  });

  it("an admin gets no exception for a Space not shared with them", async () => {
    // canView has no admin input at all: being an admin cannot open a Space.
    const s = await space("private");
    expect(await canView(s, { userId: "admin", email: "admin@example.com" })).toBe(false);
  });
});

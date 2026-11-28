import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import Waiting from "./Waiting";

const api = vi.hoisted(() => ({
  fetchWaitingState: vi.fn(),
  fetchAuthUrl: vi.fn(),
  fetchKeycloakAuthUrl: vi.fn(),
}));
vi.mock("../api", () => api);

let hidden = false;
const hrefSet = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      assign: vi.fn(),
      set href(v: string) {
        hrefSet(v);
      },
      get href() {
        return "http://localhost/waiting";
      },
    },
  });
  api.fetchWaitingState.mockResolvedValue({ state: "pending", provider: "google" });
  api.fetchAuthUrl.mockResolvedValue({ url: "https://accounts.example.com/auth" });
  api.fetchKeycloakAuthUrl.mockResolvedValue({ url: "https://kc.example.com/auth" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function mount() {
  render(<Waiting />);
  await tick(0);
}

describe("Waiting", () => {
  it("polls at once and shows the stepper with step 2 current", async () => {
    await mount();
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(1);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/leave this page open/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/waiting for approval/i);
  });

  it("backs off 5s, 10s, 20s, 40s, then caps at 60s", async () => {
    await mount();
    const expectCalls = async (ms: number, n: number) => {
      await tick(ms);
      expect(api.fetchWaitingState).toHaveBeenCalledTimes(n);
    };
    await expectCalls(4_999, 1);
    await expectCalls(1, 2);
    await expectCalls(9_999, 2);
    await expectCalls(1, 3);
    await expectCalls(20_000, 4);
    await expectCalls(40_000, 5);
    await expectCalls(59_999, 5);
    await expectCalls(1, 6);
    await expectCalls(60_000, 7);
  });

  it("keeps polling with backoff after a network error and shows nothing scary", async () => {
    api.fetchWaitingState.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(screen.queryByText(/error|failed|expired/i)).not.toBeInTheDocument();
    await tick(5_000);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(2);
  });

  it("refetches at once when the tab regains focus, and restarts the schedule", async () => {
    await mount();
    await tick(5_000);
    await tick(10_000);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(3);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await tick(0);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(4);
    await tick(5_000);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(5);
  });

  it("pauses while hidden and polls when visible again", async () => {
    await mount();
    hidden = true;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(120_000);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(0);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(2);
  });

  it("on active shows step 3 done and starts SSO with the provider the person used", async () => {
    api.fetchWaitingState.mockResolvedValue({ state: "active", provider: "keycloak" });
    await mount();
    expect(api.fetchKeycloakAuthUrl).toHaveBeenCalledWith(undefined, expect.any(String));
    expect(api.fetchAuthUrl).not.toHaveBeenCalled();
    expect(hrefSet).toHaveBeenCalledWith("https://kc.example.com/auth");
    expect(screen.getAllByRole("listitem")[2]).toHaveAttribute("aria-current", "step");
    await tick(120_000);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(1);
  });

  it("on active with google uses the google flow", async () => {
    api.fetchWaitingState.mockResolvedValue({ state: "active", provider: "google" });
    await mount();
    expect(api.fetchAuthUrl).toHaveBeenCalledWith(undefined, expect.any(String));
    expect(hrefSet).toHaveBeenCalledWith("https://accounts.example.com/auth");
  });

  it("declined replaces step 2, offers Back to sign in, and stops polling", async () => {
    api.fetchWaitingState.mockResolvedValue({ state: "declined", provider: "google" });
    await mount();
    expect(screen.getByText(/request was declined/i)).toBeInTheDocument();
    expect(screen.queryByText(/leave this page open/i)).not.toBeInTheDocument();
    screen.getByRole("button", { name: /back to sign in/i }).click();
    expect(window.location.assign).toHaveBeenCalledWith("/login");
    await tick(120_000);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(1);
  });

  it("none says the session expired, links back to login, and stops polling", async () => {
    api.fetchWaitingState.mockResolvedValue({ state: "none", provider: null });
    await mount();
    expect(screen.getAllByText(/session for this request expired/i).length).toBeGreaterThan(0);
    screen.getByRole("button", { name: /back to sign in/i }).click();
    expect(window.location.assign).toHaveBeenCalledWith("/login");
    await tick(120_000);
    expect(api.fetchWaitingState).toHaveBeenCalledTimes(1);
  });
});

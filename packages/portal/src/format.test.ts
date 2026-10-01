import { describe, it, expect } from "vitest";
import { dayLabel, timeLabel, durationLabel, relativeTime, formatBytes } from "./format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [150 * 1024 * 1024, "150 MB"],
    [3 * 1024 ** 3, "3.0 GB"],
  ])("formats %i as %s", (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });
});

// Fixed instants keep these deterministic regardless of when they run — but
// they must be built in LOCAL time, because dayLabel and timeLabel both work
// in local calendar days. A UTC literal like "2026-09-03T23:00:00Z" is the
// previous day only for viewers at or west of UTC; east of it that instant is
// already the next local day, and the test would flip on a developer's laptop.
const NOW = new Date(2026, 8, 4, 12, 0, 0); // local noon, 4 September 2026
const at = (y: number, m: number, d: number, hh = 0, mm = 0) =>
  Math.floor(new Date(y, m, d, hh, mm, 0).getTime() / 1000);

describe("dayLabel", () => {
  it("names today and yesterday", () => {
    expect(dayLabel(at(2026, 8, 4, 9, 30), NOW)).toBe("Today");
    expect(dayLabel(at(2026, 8, 3, 23, 0), NOW)).toBe("Yesterday");
  });

  it("falls back to an ISO date further back", () => {
    expect(dayLabel(at(2026, 7, 28, 10, 0), NOW)).toBe("2026-08-28");
  });
});

describe("timeLabel", () => {
  it("renders zero-padded hours and minutes", () => {
    expect(timeLabel(at(2026, 8, 4, 9, 5))).toBe("09:05");
  });
});

describe("durationLabel", () => {
  it("renders milliseconds under a second", () => {
    expect(durationLabel(412)).toBe("412ms");
  });

  it("switches to seconds at a second and above", () => {
    expect(durationLabel(1500)).toBe("1.5s");
    expect(durationLabel(12000)).toBe("12.0s");
  });

  it("renders an em dash when there is no duration", () => {
    expect(durationLabel(null)).toBe("—");
  });
});

describe("relativeTime", () => {
  it("counts minutes, hours and days back", () => {
    expect(relativeTime(at(2026, 8, 4, 11, 30), NOW)).toBe("30m ago");
    expect(relativeTime(at(2026, 8, 4, 9, 0), NOW)).toBe("3h ago");
    expect(relativeTime(at(2026, 8, 1, 12, 0), NOW)).toBe("3d ago");
  });

  it("never reports less than a minute", () => {
    expect(relativeTime(Math.floor(NOW.getTime() / 1000) - 10, NOW)).toBe("1m ago");
  });

  it("renders an em dash for a missing timestamp", () => {
    expect(relativeTime(0, NOW)).toBe("—");
  });
});

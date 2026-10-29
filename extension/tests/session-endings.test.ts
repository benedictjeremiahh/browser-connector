import { describe, expect, it, vi } from "vitest";
import { SessionEndings, isSessionEnded } from "../src/session-endings";

describe("SessionEndings", () => {
  it("releases an ended session after the grace period", async () => {
    vi.useFakeTimers();
    const released: string[] = [];
    const endings = new SessionEndings(async (id) => { released.push(id); }, 5_000);
    endings.ended("s1");
    vi.advanceTimersByTime(4_999);
    expect(released).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(released).toEqual(["s1"]);
    vi.useRealTimers();
  });

  it("keeps a session that sends another request within the grace period", () => {
    vi.useFakeTimers();
    const released: string[] = [];
    const endings = new SessionEndings(async (id) => { released.push(id); }, 5_000);
    endings.ended("s1");
    endings.ended("s2");
    vi.advanceTimersByTime(2_000);
    endings.resumed("s1");
    vi.advanceTimersByTime(10_000);
    expect(released).toEqual(["s2"]);
    vi.useRealTimers();
  });

  it("recognizes only a well-formed session_ended message", () => {
    expect(isSessionEnded({ kind: "session_ended", sessionId: "s1", hostId: "opencode" })).toBe(true);
    expect(isSessionEnded({ kind: "session_ended", sessionId: "", hostId: "opencode" })).toBe(false);
    expect(isSessionEnded({ kind: "request", sessionId: "s1", hostId: "opencode" })).toBe(false);
    expect(isSessionEnded(null)).toBe(false);
  });
});

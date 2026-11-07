import { GROUP_COLORS, GROUP_MARK, groupColor, sessionGroupLabel } from "../src/naming";
import { describe, expect, it } from "vitest";

describe("tab group naming", () => {
  it("leads with the mark and takes the agent's label as the context", () => {
    expect(sessionGroupLabel({ label: "login flow" })).toBe(`${GROUP_MARK} login flow`);
  });

  it("falls back to the host, never to an opaque session id", () => {
    const title = sessionGroupLabel({ leaseHostId: "opencode", sessionId: "abcdefgh-1234" });
    expect(title).toBe(`${GROUP_MARK} opencode`);
    expect(title).not.toContain("abcdefgh");
    expect(sessionGroupLabel({ leaseHostId: "codex" })).toBe(`${GROUP_MARK} codex`);
  });

  it("never leaves a title empty", () => {
    expect(sessionGroupLabel({})).toBe(`${GROUP_MARK} Browser Connector`);
    expect(sessionGroupLabel({ sessionId: "abcdefgh" })).toBe(`${GROUP_MARK} Browser Connector`);
  });

  it("truncates by code point, so the mark is never sliced in half", () => {
    const title = sessionGroupLabel({ label: "x".repeat(200) });
    const characters = [...title];
    expect(characters.length).toBe(60);
    expect(characters[0]).toBe(GROUP_MARK);
    expect(characters.at(-1)).toBe("…");
  });

  it("falls back to the host colour when no session id is available", () => {
    expect(groupColor("opencode")).toBe(groupColor("opencode"));
    expect(groupColor(undefined)).toBe("green");
    expect(groupColor("  ")).toBe("green");
  });

  it("gives one session one color, whatever host or label it has", () => {
    expect(groupColor("opencode", "session-a")).toBe(groupColor("opencode", "session-a"));
    expect(groupColor("opencode", "session-a")).toBe(groupColor("codex", "session-a"));
    expect(groupColor(undefined, "session-a")).toBe(groupColor("opencode", "session-a"));
    expect(groupColor("opencode", "")).toBe(groupColor("opencode"));
  });

  it("gives different sessions different colors in practice", () => {
    const colors = new Set(Array.from({ length: 32 }, (_, index) => groupColor("opencode", `session-${index}`)));
    expect(colors.size).toBeGreaterThan(1);
    for (const color of colors) expect(GROUP_COLORS).toContain(color);
  });
});

import {
  DEFAULT_MARK,
  GROUP_COLORS,
  explicitMark,
  groupColor,
  isConnectorGroupTitle,
  normalizeMark,
  sessionGroupLabel,
  sessionMark,
  withoutLeadingMark
} from "../src/naming";
import { describe, expect, it } from "vitest";

describe("topic marks", () => {
  it("reads the topic from the label", () => {
    expect(sessionMark({ label: "fix the failing checkout test" })).toBe("🐛");
    expect(sessionMark({ label: "update README docs" })).toBe("📄");
    expect(sessionMark({ label: "design review for the drawer" })).toBe("🎨");
  });

  it("reads the topic from the URL when the label says nothing", () => {
    expect(sessionMark({ url: "https://github.com/acme/repo/pull/12" })).toBe("🧑‍💻");
    expect(sessionMark({ url: "https://mail.google.com/mail/u/0" })).toBe("✉️");
  });

  it("keeps an emoji the agent typed, including its variation selector", () => {
    expect(sessionMark({ label: "🚀 ship the release" })).toBe("🚀");
    expect(explicitMark("✉️ inbox triage")).toBe("✉️");
    expect(explicitMark("inbox triage")).toBeUndefined();
  });

  it("accepts a mark the caller chose only when it is one emoji", () => {
    expect(normalizeMark("🐛")).toBe("🐛");
    expect(normalizeMark(" 🧑‍💻 ")).toBe("🧑‍💻");
    expect(normalizeMark("🐛 fix the test")).toBeUndefined();
    expect(normalizeMark("abc")).toBeUndefined();
    expect(normalizeMark("")).toBeUndefined();
  });

  it("falls back to a neutral mark, not a fixed plug", () => {
    expect(sessionMark({})).toBe(DEFAULT_MARK);
    expect(sessionMark({ label: "login flow" })).toBe(DEFAULT_MARK);
  });
});

describe("tab group naming", () => {
  it("leads with the session mark and the agent's label", () => {
    expect(sessionGroupLabel({ label: "login flow", mark: "🧑‍💻" })).toBe("🧑‍💻 login flow");
  });

  it("does not repeat an emoji that is already in the label", () => {
    expect(sessionGroupLabel({ label: "🐛 fix login" })).toBe("🐛 fix login");
    expect(withoutLeadingMark("🐛 fix login")).toBe("fix login");
  });

  it("falls back to the host, never to an opaque session id", () => {
    const title = sessionGroupLabel({ leaseHostId: "opencode", sessionId: "abcdefgh-1234" });
    expect(title).toBe(`${DEFAULT_MARK} opencode`);
    expect(title).not.toContain("abcdefgh");
    expect(sessionGroupLabel({ leaseHostId: "codex" })).toBe(`${DEFAULT_MARK} codex`);
  });

  it("never leaves a title empty", () => {
    expect(sessionGroupLabel({})).toBe(`${DEFAULT_MARK} Browser Connector`);
    expect(sessionGroupLabel({ sessionId: "abcdefgh" })).toBe(`${DEFAULT_MARK} Browser Connector`);
  });

  it("truncates by code point, so the mark is never sliced in half", () => {
    const title = sessionGroupLabel({ label: "x".repeat(200) });
    const characters = [...title];
    expect(characters.length).toBe(60);
    expect(characters[0]).toBe(DEFAULT_MARK);
    expect(characters.at(-1)).toBe("…");
  });

  it("recognises a connector group by its emoji mark", () => {
    expect(isConnectorGroupTitle("🐛 fix login")).toBe(true);
    expect(isConnectorGroupTitle(DEFAULT_MARK)).toBe(true);
    expect(isConnectorGroupTitle("Work")).toBe(false);
    expect(isConnectorGroupTitle(undefined)).toBe(false);
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

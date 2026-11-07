/// <reference types="vite/client" />
import { ERROR_HINTS } from "../src/browser";
import { describe, expect, it } from "vitest";

/* Every code the extension throws should tell the caller what to do next. The list
   is derived from the source rather than maintained by hand, so a new error code
   without a hint fails here instead of surfacing as a bare message in a run. */
describe("error hints", () => {
  const sources = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const source = Object.values(sources).join("\n");
  const codes = new Set([...source.matchAll(/connectorError\("([a-z_]+)"/g)].map((match) => match[1]!));
  /* This one crosses a call boundary as a value, so the regex above does not see it. */
  codes.add("critical_action_not_batchable");

  it("finds the codes it is meant to check", () => {
    expect(codes.size).toBeGreaterThan(20);
    expect(codes.has("stale_page_ref")).toBe(true);
  });

  it("gives every thrown code a non-empty hint", () => {
    const missing = [...codes].filter((code) => !ERROR_HINTS[code]);
    expect(missing).toEqual([]);
    for (const code of codes) expect(ERROR_HINTS[code]!.trim().length, code).toBeGreaterThan(10);
  });
});

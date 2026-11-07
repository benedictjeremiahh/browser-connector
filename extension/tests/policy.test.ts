import { boundedText, classifyRequest, exactOrigin, isBlankTabUrl, isLocalDevelopmentOrigin, isRestrictedUrl, methodsNeedingApproval, redactUrl, sameNavigationTarget } from "../src/policy";
import { describe, expect, it } from "vitest";

describe("connector policy", () => {
  it("allows local development origins without a Site Grant, and nothing that only looks local", () => {
    for (const origin of ["http://localhost:5180", "http://127.0.0.1:3170", "http://[::1]:8080", "http://app.localhost", "https://shop.test"]) {
      expect(isLocalDevelopmentOrigin(origin)).toBe(true);
    }
    for (const origin of ["https://localhost.example.com", "https://mail.google.com", "http://127.0.0.2", "https://test.dev", "http://example.testing"]) {
      expect(isLocalDevelopmentOrigin(origin)).toBe(false);
    }
  });

  it("asks for each script run and file transfer, including inside a batch", () => {
    expect(methodsNeedingApproval("javascript_tool", {})).toEqual(["javascript_tool"]);
    expect(methodsNeedingApproval("download_file", {})).toEqual(["download_file"]);
    expect(methodsNeedingApproval("computer", { action: "click" })).toEqual([]);
    expect(methodsNeedingApproval("browser_batch", { actions: [
      { tool: "find", arguments: {} }, { tool: "upload_file", arguments: {} }
    ] })).toEqual(["upload_file"]);
  });

  it("classifies Claude-shaped read tools as read-only", () => {
    expect(classifyRequest("read_page", {}).risk).toBe("read_only");
    expect(classifyRequest("read_network_requests", { includeResponseBody: true }).risk).toBe("protected");
  });

  it("keeps tabs_context a read even if an older caller passes createIfEmpty", () => {
    expect(classifyRequest("tabs_context", {}).risk).toBe("read_only");
    expect(classifyRequest("tabs_context", { createIfEmpty: true }).risk).toBe("read_only");
  });

  it("recognizes the blank destinations a tab may start at", () => {
    expect(isBlankTabUrl("about:blank")).toBe(true);
    expect(isBlankTabUrl("about:blank#top")).toBe(true);
    expect(isBlankTabUrl(undefined, "chrome://newtab/")).toBe(true);
    expect(isBlankTabUrl("chrome://newtab")).toBe(true);
    expect(isBlankTabUrl("chrome://settings")).toBe(false);
    expect(isBlankTabUrl("chrome://newtabfoo")).toBe(false);
    expect(isBlankTabUrl("https://example.com/")).toBe(false);
    expect(isBlankTabUrl("about:blank", "https://example.com/")).toBe(false);
  });

  it("treats wait_for and assert as read-only, including inside a batch", () => {
    expect(classifyRequest("wait_for", {}).risk).toBe("read_only");
    expect(classifyRequest("assert", { expect: [] }).risk).toBe("read_only");
    expect(classifyRequest("browser_batch", { actions: [{ tool: "assert", arguments: {} }] }).risk).toBe("read_only");
  });

  it("never treats arbitrary JavaScript as routine", () => {
    expect(classifyRequest("javascript_tool", { source: "1 + 1" }).risk).toBe("protected");
  });

  it("inherits the highest batch risk", () => {
    const result = classifyRequest("browser_batch", {
      actions: [
        { tool: "read_page", arguments: {} },
        { tool: "upload_file", arguments: {} }
      ]
    });
    expect(result.risk).toBe("protected");
  });

  it("recognizes critical target labels", () => {
    expect(classifyRequest("computer", { action: "click", pageRef: "r1" }, "Place order").risk).toBe("critical");
  });

  it("restricts privileged schemes and keeps exact origins", () => {
    expect(isRestrictedUrl("chrome://settings")).toBe(true);
    expect(isRestrictedUrl("https://example.com/path")).toBe(false);
    expect(exactOrigin("http://localhost:3000/a")).toBe("http://localhost:3000");
  });

  it("treats the same page with a different fragment or query order as one target", () => {
    expect(sameNavigationTarget("https://example.com/a#one", "https://example.com/a#two")).toBe(true);
    expect(sameNavigationTarget("https://example.com/?b=2&a=1", "https://example.com/?a=1&b=2")).toBe(true);
    expect(sameNavigationTarget("https://example.com/?a=1", "https://example.com/?a=2")).toBe(false);
  });

  it("redacts query values and bounds UTF-8 output", () => {
    expect(redactUrl("https://example.com/?token=secret#x")).toBe("https://example.com/?token=%5Bredacted%5D");
    expect(redactUrl("https://user:pw@example.com/a")).toBe("https://example.com/a");
    expect(redactUrl("http://localhost:5180/inventory?tab=transfers&page=2")).toBe("http://localhost:5180/inventory?tab=transfers&page=2");
    expect(redactUrl("https://example.com/cb?state=abc&code=xyz")).toBe("https://example.com/cb?state=%5Bredacted%5D&code=%5Bredacted%5D");
    expect(redactUrl("https://example.com/s?q=" + "a".repeat(30))).toBe("https://example.com/s?q=%5Bredacted%5D");
    expect(redactUrl("https://example.com/u?who=ana@example.com")).toBe("https://example.com/u?who=%5Bredacted%5D");
    expect(redactUrl("https://example.com/reset/abcdefghijklmnop1234")).toBe("https://example.com/reset/[redacted]");
    expect(redactUrl("https://example.com/x/eyJhbGciOi.eyJzdWIiOi.sig")).toBe("https://example.com/x/[redacted]");
    expect(redactUrl("https://example.com/orders/3f2b1c4d-1111-4222-8333-444455556666/edit")).toBe("https://example.com/orders/3f2b1c4d-1111-4222-8333-444455556666/edit");
    expect(redactUrl("https://example.com/blog/how-to-print-a-delivery-note-quickly")).toBe("https://example.com/blog/how-to-print-a-delivery-note-quickly");
    const bounded = boundedText("abcdefgh", 4);
    expect(bounded).toMatchObject({ text: "abcd", truncated: true, originalBytes: 8 });
  });
});

describe("query redaction", () => {
  it("matches key parts, so ordinary filters stay readable and short opaque tokens do not", () => {
    expect(redactUrl("https://example.com/s?keyword=kaca&country_code=id&author=ana")).toContain("keyword=kaca");
    expect(redactUrl("https://example.com/s?api_key=x1&sid=abc&invite=zz")).toBe("https://example.com/s?api_key=%5Bredacted%5D&sid=%5Bredacted%5D&invite=%5Bredacted%5D");
    expect(redactUrl("https://example.com/l?r=ab12cd34ef56gh78")).toBe("https://example.com/l?r=%5Bredacted%5D");
  });
});

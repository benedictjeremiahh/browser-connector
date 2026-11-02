import { boundedText, classifyRequest, exactOrigin, isRestrictedUrl, redactUrl } from "../src/policy";
import { describe, expect, it } from "vitest";

describe("connector policy", () => {
  it("classifies Claude-shaped read tools as read-only", () => {
    expect(classifyRequest("read_page", {}).risk).toBe("read_only");
    expect(classifyRequest("read_network_requests", { includeResponseBody: true }).risk).toBe("protected");
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

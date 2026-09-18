import { boundedText, classifyRequest, exactOrigin, isRestrictedUrl, redactUrl } from "../src/policy";
import { describe, expect, it } from "vitest";

describe("connector policy", () => {
  it("classifies Claude-shaped read tools as read-only", () => {
    expect(classifyRequest("read_page", {}, "auto").risk).toBe("read_only");
    expect(classifyRequest("read_network_requests", { includeResponseBody: true }, "auto").risk).toBe("protected");
  });

  it("never treats arbitrary JavaScript as routine", () => {
    expect(classifyRequest("javascript_tool", { source: "1 + 1" }, "auto").risk).toBe("protected");
  });

  it("inherits the highest batch risk", () => {
    const result = classifyRequest("browser_batch", {
      actions: [
        { tool: "read_page", arguments: {} },
        { tool: "upload_file", arguments: {} }
      ]
    }, "auto");
    expect(result.risk).toBe("protected");
  });

  it("recognizes critical target labels", () => {
    expect(classifyRequest("computer", { action: "click", pageRef: "r1" }, "auto", "Place order").risk).toBe("critical");
  });

  it("restricts privileged schemes and keeps exact origins", () => {
    expect(isRestrictedUrl("chrome://settings")).toBe(true);
    expect(isRestrictedUrl("https://example.com/path")).toBe(false);
    expect(exactOrigin("http://localhost:3000/a")).toBe("http://localhost:3000");
  });

  it("redacts query values and bounds UTF-8 output", () => {
    expect(redactUrl("https://example.com/?token=secret#x")).toBe("https://example.com/?token=%5Bredacted%5D");
    const bounded = boundedText("abcdefgh", 4);
    expect(bounded).toMatchObject({ text: "abcd", truncated: true, originalBytes: 8 });
  });
});

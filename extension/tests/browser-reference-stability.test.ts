import { BrowserController } from "../src/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { __browserConnectorPageRefState?: unknown }).__browserConnectorPageRefState;
});

class MockElement {
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: MockElement[] = [];
  isConnected = true;
  parent: MockElement | null = null;
  dispatchCount = 0;
  scrollCount = 0;
  focusCount = 0;

  constructor(readonly innerText: string, readonly tagName = "DIV", readonly role = "") {
    this.attributes.set("role", role);
  }

  get textContent(): string { return this.innerText; }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }

  getBoundingClientRect(): { width: number; height: number } { return { width: 20, height: 10 }; }

  scrollIntoView(): void { this.scrollCount += 1; }

  focus(): void { this.focusCount += 1; (document as unknown as { activeElement: MockElement }).activeElement = this; }

  dispatchEvent(): boolean { this.dispatchCount += 1; return true; }

  closest(): null { return null; }

  contains(element: MockElement): boolean {
    return element === this || this.children.some(child => child.contains(element));
  }

  get isReadable(): boolean {
    return !!this.role || ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "H1", "H2", "H3", "H4", "H5", "H6", "P", "LI"].includes(this.tagName);
  }

  append(element: MockElement): void {
    element.parent = this;
    this.children.push(element);
  }

  cloneNode(): MockElement {
    const clone = new MockElement(this.innerText, this.tagName, this.role);
    for (const [key, value] of this.attributes) clone.attributes.set(key, value);
    Object.assign(clone.dataset, this.dataset);
    return clone;
  }
}

class MockInput extends MockElement {
  readonly placeholder = "";
  value = "original";
  files: unknown;

  constructor(text: string, readonly type: string) { super(text, "INPUT"); }

  override cloneNode(): MockInput {
    const clone = new MockInput(this.innerText, this.type);
    Object.assign(clone.dataset, this.dataset);
    clone.value = this.value;
    return clone;
  }
}

function createDocument(elements: MockElement[]): Record<string, unknown> {
  return {
    title: "Generic example.test page",
    body: {},
    querySelectorAll: (selector: string) => selector === "body *" || selector === "*" ? elements : elements.filter(element => element.isReadable),
    querySelector: () => null,
  };
}

function harness(initialElements: MockElement[]) {
  const navigationListeners: Array<(details: { tabId: number; frameId: number }) => void> = [];
  const listener = { addListener: vi.fn() };
  vi.stubGlobal("chrome", {
    tabs: { onRemoved: listener },
    webNavigation: { onCommitted: { addListener: (handler: (details: { tabId: number; frameId: number }) => void) => navigationListeners.push(handler) } },
    debugger: { onEvent: listener, onDetach: listener, attach: async () => {}, sendCommand: async () => ({}) },
    scripting: {
      executeScript: async (input: { func: (...args: unknown[]) => unknown; args: unknown[] }) => [
        { result: input.func(...input.args) }
      ]
    }
  });
  vi.stubGlobal("location", { origin: "https://example.test", pathname: "/page" });
  vi.stubGlobal("HTMLInputElement", MockInput);
  vi.stubGlobal("HTMLButtonElement", class {});
  vi.stubGlobal("HTMLAnchorElement", class {});
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLSelectElement", class {});
  let elements = initialElements;
  let currentDocument = createDocument(elements);
  vi.stubGlobal("document", currentDocument);
  const controller = new BrowserController();
  return {
    controller,
    setElements(next: MockElement[]) {
      elements = next;
      currentDocument.querySelectorAll = (selector: string) => selector === "body *" || selector === "*" ? elements : elements.filter(element => element.isReadable);
    },
    replaceDocument(next: MockElement[]) {
      elements = next;
      currentDocument = createDocument(elements);
      vi.stubGlobal("document", currentDocument);
    },
    commit() { navigationListeners.forEach(listener => listener({ tabId: 7, frameId: 0 })); },
  };
}

describe("stable document Page References", () => {
  it("keeps a find scope stable across both pages of a scoped read", async () => {
    const root = new MockElement("scope phrase first second", "DIV", "main");
    const firstChild = new MockElement("first", "P");
    const secondChild = new MockElement("second", "P");
    root.append(firstChild);
    root.append(secondChild);
    const h = harness([root, firstChild, secondChild]);

    const found = await h.controller.dispatch("find", { tabId: 7, query: "scope phrase", limit: 10 }, new Set([7])) as {
      matches: Array<{ ref: string }>;
    };
    const scopeRef = found.matches[0]!.ref;
    const firstPageBytes = new TextEncoder().encode(JSON.stringify({ ref: scopeRef, role: "main", name: root.innerText })).length;
    const firstPage = await h.controller.dispatch("read_page", { tabId: 7, scopeRef, maxBytes: firstPageBytes }, new Set([7])) as {
      nodes: Array<{ ref: string; name: string }>;
      nextCursor: string | null;
      staleScopeRef?: boolean;
    };
    expect(firstPage.staleScopeRef).not.toBe(true);
    expect(firstPage.nodes.map(node => node.ref)).toEqual([scopeRef]);
    expect(firstPage.nextCursor).toBe("1");

    const secondPage = await h.controller.dispatch("read_page", {
      tabId: 7, scopeRef, cursor: firstPage.nextCursor, maxBytes: 10_000
    }, new Set([7])) as { nodes: Array<{ name: string }>; nextCursor: string | null; staleScopeRef?: boolean };
    expect(secondPage.staleScopeRef).not.toBe(true);
    expect(secondPage.nodes.map(node => node.name)).toEqual(["first", "second"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("preserves read refs through find and DOM movement without recycling removed IDs", async () => {
    const first = new MockElement("needle first", "P");
    const removed = new MockElement("needle removed", "P");
    const h = harness([first, removed]);
    const initial = await h.controller.dispatch("read_page", { tabId: 7 }, new Set([7])) as { nodes: Array<{ ref: string }> };
    const firstRef = initial.nodes[0]!.ref;
    const removedRef = initial.nodes[1]!.ref;

    const inserted = new MockElement("needle inserted", "P");
    h.setElements([inserted, removed, first]);
    const afterMove = await h.controller.dispatch("find", { tabId: 7, query: "needle", limit: 10 }, new Set([7])) as {
      matches: Array<{ ref: string; name: string }>;
    };
    expect(afterMove.matches.map(match => match.ref)).toEqual(["p1-2", removedRef, firstRef]);
    await expect(h.controller.dispatch("get_page_text", { tabId: 7, scopeRef: firstRef }, new Set([7])))
      .resolves.toMatchObject({ text: "needle first", staleScopeRef: false });
    const insertedRef = afterMove.matches[0]!.ref;

    removed.isConnected = false;
    const replacement = new MockElement("needle replacement", "P");
    h.setElements([inserted, replacement, first]);
    const afterReplacement = await h.controller.dispatch("find", { tabId: 7, query: "needle", limit: 10 }, new Set([7])) as {
      matches: Array<{ ref: string; name: string }>;
    };
    expect(afterReplacement.matches.map(match => match.ref)).toEqual([insertedRef, "p1-3", firstRef]);
    expect(afterReplacement.matches[1]!.ref).not.toBe(removedRef);
  });

  it("starts fresh references after document generation or identity changes", async () => {
    const original = new MockElement("original", "P");
    const h = harness([original]);
    h.commit();
    const first = await h.controller.dispatch("read_page", { tabId: 7 }, new Set([7])) as { nodes: Array<{ ref: string }> };
    expect(first.nodes[0]!.ref).toBe("p1-0");

    h.commit();
    const staleScope = await h.controller.dispatch("read_page", { tabId: 7, scopeRef: first.nodes[0]!.ref }, new Set([7])) as {
      staleScopeRef?: boolean;
    };
    expect(staleScope.staleScopeRef).toBe(true);
    await expect(h.controller.dispatch("get_page_text", { tabId: 7, scopeRef: first.nodes[0]!.ref }, new Set([7])))
      .resolves.toMatchObject({ text: "", staleScopeRef: true });
    await expect(h.controller.describePageRef(7, first.nodes[0]!.ref)).resolves.toEqual({ description: "" });
    await expect(h.controller.dispatch("form_input", { tabId: 7, pageRef: first.nodes[0]!.ref, value: "stale" }, new Set([7])))
      .rejects.toMatchObject({ code: "stale_page_ref" });
    const nextGeneration = await h.controller.dispatch("read_page", { tabId: 7 }, new Set([7])) as { nodes: Array<{ ref: string }> };
    expect(nextGeneration.nodes[0]!.ref).toBe("p2-1");

    const sameGenerationNewDocument = new MockElement("same generation replacement", "P");
    h.replaceDocument([sameGenerationNewDocument]);
    const nextIdentity = await h.controller.dispatch("read_page", { tabId: 7 }, new Set([7])) as { nodes: Array<{ ref: string }> };
    expect(nextIdentity.nodes[0]!.ref).toBe("p2-2");

    const replacementDocument = new MockElement("replacement document", "P");
    h.commit();
    h.replaceDocument([replacementDocument]);
    const nextDocument = await h.controller.dispatch("read_page", { tabId: 7 }, new Set([7])) as { nodes: Array<{ ref: string }> };
    expect(nextDocument.nodes[0]!.ref).toBe("p3-3");
  });

  it("rejects a cloned dataset ref in every consumer while retaining the issued element identity", async () => {
    const button = new MockElement("Original button", "BUTTON");
    const textInput = new MockInput("Original text input", "text");
    const fileInput = new MockInput("Original file input", "file");
    const h = harness([button, textInput, fileInput]);
    const initial = await h.controller.dispatch("read_page", { tabId: 7 }, new Set([7])) as { nodes: Array<{ ref: string }> };
    const [buttonRef, textRef, fileRef] = initial.nodes.map(node => node.ref);
    expect(buttonRef).toBeDefined();
    expect(textRef).toBeDefined();
    expect(fileRef).toBeDefined();

    const buttonClone = button.cloneNode();
    const textClone = textInput.cloneNode();
    const fileClone = fileInput.cloneNode();
    button.isConnected = false;
    textInput.isConnected = false;
    fileInput.isConnected = false;
    h.setElements([buttonClone, textClone, fileClone]);

    expect(buttonClone.dataset.browserConnectorRef).toBe(buttonRef);
    const pageRead = await h.controller.dispatch("read_page", { tabId: 7, scopeRef: buttonRef }, new Set([7])) as { staleScopeRef?: boolean };
    expect(pageRead.staleScopeRef).toBe(true);
    await expect(h.controller.dispatch("get_page_text", { tabId: 7, scopeRef: buttonRef }, new Set([7])))
      .resolves.toMatchObject({ text: "", staleScopeRef: true });
    await expect(h.controller.describePageRef(7, buttonRef!)).resolves.toEqual({ description: "" });
    await expect(h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: buttonRef }, new Set([7])))
      .rejects.toMatchObject({ code: "stale_page_ref" });
    await expect(h.controller.dispatch("computer", { tabId: 7, action: "type", pageRef: textRef, text: "changed" }, new Set([7])))
      .rejects.toMatchObject({ code: "stale_page_ref" });
    await expect(h.controller.dispatch("form_input", { tabId: 7, pageRef: textRef, value: "changed" }, new Set([7])))
      .rejects.toMatchObject({ code: "stale_page_ref" });
    await expect(h.controller.dispatch("upload_file", {
      tabId: 7, pageRef: fileRef, name: "fixture.txt", mimeType: "text/plain", dataBase64: "U1lOVEhFVElD"
    }, new Set([7]))).rejects.toMatchObject({ code: "upload_failed" });
    expect(buttonClone.scrollCount + buttonClone.focusCount + buttonClone.dispatchCount).toBe(0);
    expect(textClone.value).toBe("original");
    expect(textClone.dispatchCount).toBe(0);
    expect(fileClone.dispatchCount).toBe(0);
  });
});

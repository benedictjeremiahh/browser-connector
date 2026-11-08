/* Helpers that run inside the page, shared by every injected function.

   chrome.scripting serializes an injected function on its own, so it cannot import anything: each
   function used to carry its own copy of the Page Reference bookkeeping. Walking into open shadow
   roots and same-origin iframes needs more than a few lines, so it is installed once per document
   as globalThis.__browserConnectorRuntime and the injected functions use it. Everything in this
   file that runs in the page must stay inside injectedInstallRuntime or injectedAssert: a module
   level constant would not exist there. */

export interface RefState {
  document: Document;
  generation: number;
  refs: WeakMap<Element, string>;
  next: number;
}

export interface RuntimeRoot {
  root: Document | ShadowRoot;
  /* The shadow host or the iframe this root hangs from; null for the top document. */
  host: Element | null;
  elements: HTMLElement[];
}

export interface Scan {
  roots: RuntimeRoot[];
  /* Elements whose content cannot be read, with the reason: cross-origin frames, closed shadow roots. */
  opaque: Map<Element, string>;
  /* The selector runs in the top document and in every iframe document; shadowSelector in every shadow root. */
  query(selector: string, shadowSelector?: string): HTMLElement[];
  all(): HTMLElement[];
  resolve(ref: string, state: RefState): HTMLElement | null;
}

export interface PageRuntime {
  ensureState(generation: number): RefState;
  currentState(generation: number): RefState | null;
  refFor(state: RefState, element: HTMLElement): string;
  scan(): Scan;
  is(element: unknown, constructorName: string): boolean;
  sensitive(input: HTMLInputElement): boolean;
  hostChain(element: Element): Element[];
  within(ancestor: Element, element: Element): boolean;
  activeIn(element: Element): Element | null;
  frameOffset(element: Element): { x: number; y: number };
  visible(element: Element): boolean;
  nameOf(element: HTMLElement, limit?: number): string;
  roleMatches(element: Element, role: string): boolean;
  visibleText(scan: Scan): string;
}

export type RuntimeGlobal = typeof globalThis & {
  __browserConnectorRuntime?: PageRuntime;
  __browserConnectorPageRefState?: RefState;
};

/* The message an injected function throws when the runtime is missing, so the caller can install it and retry. */
export const RUNTIME_MISSING = "browser-connector-runtime-missing";

export function injectedInstallRuntime(): void {
  const global = globalThis as RuntimeGlobal & { chrome?: { dom?: { openOrClosedShadowRoot?: (element: Element) => ShadowRoot | null } } };
  /* Nesting of shadow roots and iframes counts together; a page deeper than this is reported, not walked. */
  const maxNesting = 6;
  const maxRoots = 200;

  const is = (element: unknown, constructorName: string): boolean => {
    const view = (element as Element | null)?.ownerDocument?.defaultView as unknown as Record<string, unknown> | null | undefined;
    /* An element of an iframe is an instance of the iframe's constructors, not this window's. */
    return [view?.[constructorName], (globalThis as unknown as Record<string, unknown>)[constructorName]]
      .some(candidate => typeof candidate === "function" && element instanceof (candidate as new () => object));
  };

  const ensureState = (generation: number): RefState => {
    let state = global.__browserConnectorPageRefState;
    if (!state || state.document !== document || state.generation !== generation) {
      state = { document, generation, refs: new WeakMap<Element, string>(), next: state?.next ?? 0 };
      global.__browserConnectorPageRefState = state;
    }
    return state;
  };
  const currentState = (generation: number): RefState | null => {
    const state = global.__browserConnectorPageRefState;
    return state && state.document === document && state.generation === generation ? state : null;
  };
  const refFor = (state: RefState, element: HTMLElement): string => {
    const existing = state.refs.get(element);
    if (existing) { element.dataset.browserConnectorRef = existing; return existing; }
    const ref = `p${state.generation}-${state.next++}`;
    state.refs.set(element, ref);
    element.dataset.browserConnectorRef = ref;
    return ref;
  };

  /* Only a content script can see a closed shadow root; here it only tells that one is there. */
  const hasClosedRoot = (element: Element): boolean => {
    if (!String(element.tagName ?? "").includes("-") || element.shadowRoot) return false;
    try { return !!global.chrome?.dom?.openOrClosedShadowRoot?.(element); } catch { return false; }
  };

  const scan = (): Scan => {
    const roots: RuntimeRoot[] = [];
    const opaque = new Map<Element, string>();
    const queue: Array<{ root: Document | ShadowRoot; host: Element | null; depth: number }> = [{ root: document, host: null, depth: 0 }];
    for (let index = 0; index < queue.length; index += 1) {
      const { root, host, depth } = queue[index]!;
      const elements = [...root.querySelectorAll<HTMLElement>("*")];
      roots.push({ root, host, elements });
      for (const element of elements) {
        const tag = String(element.tagName ?? "").toUpperCase();
        const tooDeep = depth + 1 > maxNesting || queue.length >= maxRoots;
        if (element.shadowRoot) {
          if (tooDeep) opaque.set(element, "open shadow root beyond the depth limit, not inspected");
          else queue.push({ root: element.shadowRoot, host: element, depth: depth + 1 });
        } else if (hasClosedRoot(element)) {
          opaque.set(element, "closed shadow root, not inspected");
        }
        if (tag === "IFRAME" || tag === "FRAME") {
          let frameDocument: Document | null = null;
          try { frameDocument = (element as HTMLIFrameElement).contentDocument; } catch { /* cross-origin */ }
          if (!frameDocument?.documentElement) opaque.set(element, "cross-origin, not inspected");
          else if (tooDeep) opaque.set(element, "beyond the depth limit, not inspected");
          else queue.push({ root: frameDocument, host: element, depth: depth + 1 });
        }
      }
    }
    const query = (selector: string, shadowSelector = selector): HTMLElement[] => roots.flatMap(entry => {
      const wanted = entry.root.nodeType === 11 ? shadowSelector : selector;
      return wanted === "*" ? entry.elements : [...entry.root.querySelectorAll<HTMLElement>(wanted)];
    });
    const all = () => roots.flatMap(entry => entry.elements);
    const resolve = (ref: string, state: RefState): HTMLElement | null =>
      all().find(candidate => state.refs.get(candidate) === ref && candidate.isConnected) ?? null;
    return { roots, opaque, query, all, resolve };
  };

  /* Shadow hosts and iframes between an element and the top document, innermost first. */
  const hostChain = (element: Element): Element[] => {
    const chain: Element[] = [];
    let current: Element | null = element;
    for (let step = 0; current && step < maxNesting * 2; step += 1) {
      const root = current.getRootNode?.() as (Partial<ShadowRoot> & Partial<Document>) | undefined;
      const host: Element | null = (root?.host as Element | undefined) ?? root?.defaultView?.frameElement ?? null;
      if (!host) break;
      chain.push(host);
      current = host;
    }
    return chain;
  };
  const within = (ancestor: Element, element: Element): boolean =>
    ancestor === element || ancestor.contains(element) || hostChain(element).some(host => host === ancestor || ancestor.contains(host));
  const activeIn = (element: Element): Element | null => {
    const root = element.getRootNode?.() as { activeElement?: Element | null } | undefined;
    return root && "activeElement" in root ? root.activeElement ?? null : document.activeElement;
  };

  /* Where an element's own viewport origin sits in the top viewport: the iframes it is nested in. */
  const frameOffset = (element: Element): { x: number; y: number } => {
    let x = 0; let y = 0;
    if (!element.ownerDocument || element.ownerDocument === document) return { x, y };
    for (const frame of hostChain(element)) {
      const tag = String(frame.tagName ?? "").toUpperCase();
      if (tag !== "IFRAME" && tag !== "FRAME") continue;
      const rect = frame.getBoundingClientRect();
      const style = frame.ownerDocument?.defaultView?.getComputedStyle?.(frame);
      x += rect.left + ((frame as HTMLElement).clientLeft || 0) + (parseFloat(style?.paddingLeft ?? "") || 0);
      y += rect.top + ((frame as HTMLElement).clientTop || 0) + (parseFloat(style?.paddingTop ?? "") || 0);
    }
    return { x, y };
  };

  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const compute = element.ownerDocument?.defaultView?.getComputedStyle ?? (typeof getComputedStyle === "function" ? getComputedStyle : undefined);
    return (compute?.call(element.ownerDocument?.defaultView ?? globalThis, element)?.visibility ?? "visible") !== "hidden";
  };

  /* The accessible-name subset an agent relies on: aria-labelledby, aria-label, the
     associated label or alt/value, then title and placeholder. Without this an icon
     button named only by <img alt> or aria-labelledby is unreachable by find. */
  const nameOf = (element: HTMLElement, limit = 200): string => {
    const text = (value: string | null | undefined) => (value ?? "").trim().replace(/\s+/g, " ");
    const byIds = (ids: string | null): string => {
      if (!ids) return "";
      const document = element.ownerDocument;
      const root = element.getRootNode?.() as (Document & { getElementById?: (id: string) => Element | null }) | undefined;
      return ids.split(/\s+/).map(id => {
        const target = (root?.getElementById?.(id)) ?? document?.getElementById(id);
        return target ? target.getAttribute("aria-label") || target.textContent || "" : "";
      }).join(" ").trim();
    };
    const labelledBy = text(byIds(element.getAttribute("aria-labelledby")));
    if (labelledBy) return labelledBy.slice(0, limit);
    const ariaLabel = text(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel.slice(0, limit);
    const label = (element as HTMLInputElement).labels?.[0];
    const labelText = text(label?.innerText || label?.textContent);
    if (labelText) return labelText.slice(0, limit);
    const alt = text((element as HTMLImageElement).alt);
    if (alt) return alt.slice(0, limit);
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const field = element as HTMLInputElement;
      if (/^(button|submit|reset)$/.test(field.type) && field.value) return text(field.value).slice(0, limit);
      if (field.type === "image" && field.alt) return text(field.alt).slice(0, limit);
    }
    const title = text(element.getAttribute("title"));
    if (title) return title.slice(0, limit);
    const placeholder = text((element as HTMLInputElement).placeholder);
    if (placeholder) return placeholder.slice(0, limit);
    return text(element.innerText).slice(0, limit);
  };

  const roleMatches = (element: Element, role: string): boolean => {
    const wanted = role.trim().toLowerCase();
    const tag = String(element.tagName ?? "").toLowerCase();
    const type = String((element as HTMLInputElement).type ?? "").toLowerCase();
    let implicit = "";
    if (tag === "a") implicit = element.hasAttribute("href") ? "link" : "";
    else if (tag === "button" || tag === "summary") implicit = "button";
    else if (tag === "select") implicit = "combobox";
    else if (tag === "textarea") implicit = "textbox";
    else if (/^h[1-6]$/.test(tag)) implicit = "heading";
    else if (tag === "img") implicit = "img";
    else if (tag === "input") {
      implicit = type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : /^(button|submit|reset|image)$/.test(type) ? "button" : type === "range" ? "slider" : type === "search" ? "searchbox" : "textbox";
    }
    return [element.getAttribute("role")?.toLowerCase(), implicit, tag].includes(wanted);
  };

  /* Chrome's innerText does not cross a shadow boundary, so each open shadow root
     contributes its own text; iframe documents are added for the same reason. */
  const visibleText = (found: Scan): string =>
    found.roots.filter(entry => entry.host === null || entry.root.nodeType === 9 || entry.root.nodeType === 11)
      .map(entry => entry.root.nodeType === 11
        ? ((entry.root as ShadowRoot).textContent ?? "")
        : ((entry.root as Document).body?.innerText ?? ""))
      .join("\n");

  global.__browserConnectorRuntime = {
    ensureState, currentState, refFor, scan, is,
    /* Self-contained: the same test read_page and form_input have always used for a field that must not be echoed. */
    sensitive: input => input.type === "password"
      || /^(cc-|current-password|new-password|one-time-code)/.test(input.autocomplete ?? "")
      || /pass|secret|token|otp|cvv|cvc|card.?num|api.?key|pin$/i.test(`${input.name} ${input.id}`),
    hostChain, within, activeIn, frameOffset, visible, nameOf, roleMatches, visibleText
  };
}

export interface PageExpectation {
  index: number;
  kind: "text_present" | "text_absent" | "element" | "count";
  text?: string;
  selector?: string;
  pageRef?: string;
  name?: string;
  role?: string;
  state?: "visible" | "hidden" | "enabled" | "disabled" | "checked" | "unchecked" | "expanded" | "collapsed" | "selected" | "pressed" | "focused";
  value?: string;
  equals?: number;
  atLeast?: number;
  atMost?: number;
  visible?: boolean;
}

export interface PageExpectationResult {
  index: number;
  passed: boolean;
  /* Short and redacted: a sensitive field's value is never in it. */
  observed: string;
}

/* Checks the expectations that need the page (text, elements, counts); the URL and the title are
   checked by the extension, which already holds them redacted. */
export function injectedAssert(expectations: PageExpectation[], generation: number): PageExpectationResult[] {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const scan = rt.scan();
  const interactive = "a,button,input,select,textarea,[role],[contenteditable=true],summary,[tabindex],h1,h2,h3,h4,h5,h6,label";
  const clip = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit)}...` : value;
  const raw = rt.visibleText(scan);
  const lower = raw.toLowerCase();
  const plural = (count: number) => `${count} match${count === 1 ? "" : "es"}`;
  const disabledOf = (element: Element) => (element as HTMLButtonElement).disabled === true || !!element.matches?.(":disabled") || element.getAttribute("aria-disabled") === "true";
  const isField = (element: Element) => ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)
    || element.getAttribute("contenteditable") === "true"
    || ["textbox", "combobox", "searchbox", "spinbutton"].includes(element.getAttribute("role") ?? "");
  const checkedOf = (element: Element) => (element as HTMLInputElement).checked === true || element.getAttribute("aria-checked") === "true";
  const expandedOf = (element: Element) => element.getAttribute("aria-expanded") === "true" || (element as HTMLDetailsElement).open === true;
  const selectedOf = (element: Element) => element.getAttribute("aria-selected") === "true" || (element as HTMLOptionElement).selected === true;
  /* A label and its control both match the same name; the control is what an assertion is about. */
  /* State, value and count are about the control, even when the control has no box
     and the person interacts through its label. Visibility is checked below. */
  const controlFor = (element: HTMLElement): HTMLElement => {
    if (element.tagName.toLowerCase() !== "label") return element;
    return ((element as HTMLLabelElement).control as HTMLElement | null) ?? element;
  };

  const targets = (expectation: PageExpectation): { list: HTMLElement[]; stale?: true } => {
    if (expectation.pageRef) {
      const state = rt.currentState(generation);
      const found = state ? scan.resolve(expectation.pageRef, state) : null;
      return found ? { list: [found] } : { list: [], stale: true };
    }
    let list = [...new Set(scan.query(expectation.selector ?? interactive).map(controlFor))];
    if (expectation.role) list = list.filter(element => rt.roleMatches(element, expectation.role!));
    if (expectation.name) {
      const needle = expectation.name.toLowerCase();
      list = list.filter(element => rt.nameOf(element, 300).toLowerCase().includes(needle));
    }
    return { list };
  };

  const check = (expectation: PageExpectation): { passed: boolean; observed: string } => {
    if (expectation.kind === "text_present" || expectation.kind === "text_absent") {
      const at = lower.indexOf((expectation.text ?? "").toLowerCase());
      if (expectation.kind === "text_present") return { passed: at >= 0, observed: at >= 0 ? "found" : "not found" };
      return { passed: at < 0, observed: at < 0 ? "not shown" : `still shown: "${clip(raw.slice(Math.max(0, at - 20), at + 60).replace(/\s+/g, " "), 80)}"` };
    }
    if (expectation.kind === "count") {
      let list = targets(expectation).list;
      if (expectation.visible) list = list.filter(element => rt.visible(element));
      const count = list.length;
      const passed = (expectation.equals === undefined || count === expectation.equals)
        && (expectation.atLeast === undefined || count >= expectation.atLeast)
        && (expectation.atMost === undefined || count <= expectation.atMost);
      return { passed, observed: plural(count) };
    }
    const { list, stale } = targets(expectation);
    if (stale) return { passed: false, observed: "Page Reference is stale; call find or read_page again" };
    const parts = [plural(list.length)];
    if (!list.length) return { passed: expectation.state === "hidden", observed: parts[0]! };
    /* A hidden checkbox reached through its visible label is still seen by the person. */
    const anyVisible = list.some(element => rt.visible(element)
      || [...((element as HTMLInputElement).labels ?? [])].some(label => rt.visible(label)));
    /* A name usually matches both a field and its label; a value belongs to the field. */
    const fields = expectation.value === undefined ? [] : list.filter(isField);
    const pool = fields.length ? fields : list;
    const primary = pool.find(element => rt.visible(element)) ?? pool[0]!;
    parts.push(anyVisible ? "visible" : "none visible");
    let passed = true;
    if (expectation.state === "visible") passed = anyVisible;
    else if (expectation.state === "hidden") passed = !anyVisible;
    else if (expectation.state === "enabled" || expectation.state === "disabled") {
      const disabled = disabledOf(primary);
      parts.push(disabled ? "disabled" : "enabled");
      passed = expectation.state === "disabled" ? disabled : !disabled;
    } else if (expectation.state === "checked" || expectation.state === "unchecked") {
      const checked = checkedOf(primary);
      parts.push(checked ? "checked" : "unchecked");
      passed = expectation.state === "checked" ? checked : !checked;
    } else if (expectation.state === "expanded" || expectation.state === "collapsed") {
      const expanded = expandedOf(primary);
      parts.push(expanded ? "expanded" : "collapsed");
      passed = expectation.state === "expanded" ? expanded : !expanded;
    } else if (expectation.state === "selected" || expectation.state === "pressed" || expectation.state === "focused") {
      const on = expectation.state === "selected" ? selectedOf(primary)
        : expectation.state === "pressed" ? primary.getAttribute("aria-pressed") === "true"
          : rt.activeIn(primary) === primary;
      parts.push(on ? expectation.state : `not ${expectation.state}`);
      passed = on;
    }
    if (expectation.value !== undefined) {
      const input = rt.is(primary, "HTMLInputElement") ? primary as HTMLInputElement : null;
      if (input && rt.sensitive(input)) {
        /* Comparing would let a guess confirm a secret one value at a time. */
        passed = false;
        parts.push("value [redacted]: a sensitive field is never compared");
      } else {
        const select = rt.is(primary, "HTMLSelectElement") ? primary as HTMLSelectElement : null;
        const actual = select ? select.value : String((primary as HTMLInputElement).value ?? primary.textContent ?? "");
        /* form_input accepts a select option by value or visible label; assert does too. */
        const selectedLabel = select?.selectedOptions[0]?.text.trim();
        passed = passed && (actual === expectation.value || selectedLabel === expectation.value);
        parts.push(`value ${JSON.stringify(clip(actual, 60))}${selectedLabel && selectedLabel !== actual ? ` (label ${JSON.stringify(clip(selectedLabel, 60))})` : ""}`);
      }
    }
    return { passed, observed: parts.join("; ") };
  };

  return expectations.map(expectation => {
    try { return { index: expectation.index, ...check(expectation) }; }
    catch { return { index: expectation.index, passed: false, observed: "invalid selector" }; }
  });
}

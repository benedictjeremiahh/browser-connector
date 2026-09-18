# Chrome Web Store submission pack

Everything the developer console asks for, prepared. The store cannot be
automated: Chrome blocks both the debugger and content scripts on
`chrome.google.com/webstore` ("the extensions gallery cannot be scripted"), so
these fields are pasted by hand.

## Files

| File | Where it goes |
| --- | --- |
| `browser-connector.zip` | **Package → Upload new package.** Build it with `node scripts/package-extension.mjs`. |
| `store/screenshot-1-docked.png` (1280×800) | Store listing → Screenshots, first. |
| `store/screenshot-2-panel.png` (1280×800) | Store listing → Screenshots. |
| `store/screenshot-3-flow.png` (1280×800) | Store listing → Screenshots. |
| `store/promo-440x280.png` | Store listing → Small promo tile. |
| `store/promo-marquee-1400x560.png` | Store listing → Marquee promo image. PNG, 24-bit, **no alpha**, which is what the field demands. |
| `extension/public/icons/128.png` | Already inside the package; the console also wants a store icon. |

The package has **no `key` in its manifest**. The Web Store rejects an upload
that carries one — *"Bidang key tidak diperbolehkan dalam manifes"* — and
assigns the id itself, so **the store id is not the development id.** After the
first upload, read the id the console shows and register the bridge against it:

```sh
browser-connector install --extension-id <store-id> --host-id <your-host-id>
```

Until then the native-messaging manifest still names
`kppdjhnonomijdjifhobgeaipejojbho`, which is the id the **unpacked** install
uses; `extension/dist` keeps its `key` precisely so that one does not change.
Two installs, two ids, and `allowed_origins` can list only the ids you have
actually registered — register the store id alongside the development one
rather than replacing it.

## Store listing

**Name**: Browser Connector

**Summary** (the console caps this): Drive the browser you are already signed
into from a local AI agent. No account, no server, no telemetry.

**Category**: Developer Tools

**Detailed description**:

> Browser Connector lets an AI agent you run on your own machine drive a browser
> you are already signed into. It is a Chrome extension plus a local MCP server,
> and it exists for one loop: build, test, debug in a real browser without
> copying state between tools.
>
> The agent can read a controlled tab — its accessibility tree, text, screenshots,
> console messages and network metadata — and act in it: navigate, click, type,
> scroll, fill forms, upload and download files. A cursor marks the point being
> clicked, and screenshots come back as images.
>
> Everything stays on your computer. There is no account, no server, and no
> telemetry: page content travels over Chrome native messaging to the agent host
> you installed, and nowhere else.
>
> The extension needs a companion program, installed separately. It is open
> source under Apache-2.0 at https://github.com/benedictjeremiahh/browser-connector,
> which is also where the MCP server and the install steps live.
>
> This is a development tool. It does not ask before acting: any paired agent can
> read and change any site the browser can reach, including where you are signed
> in. The side panel shows what is connected and every call that was made, and
> the Control Lease can be revoked at any time.

## Privacy practices

**Single purpose**: let an AI agent running on this computer observe and operate
a browser tab the user has placed under its control, over a local connection.

**Remote code**: **No.** Nothing is fetched and executed; the package is the
whole program. `javascript_tool` passes a string the local agent supplies to
Chrome's own scripting API — that is user-supplied input to an extension API,
not code the extension loads.

**Data handling**: the extension reads website content, form values (never
passwords), console output, network metadata and screenshots, and returns them
over a local socket to the agent host on the same machine. Nothing is sent to
the developer, to any server, or to a third party, and nothing is used for
advertising, profiling, or any purpose other than the one above. The stores
that would apply if the developer received it — sale, unrelated use,
creditworthiness — do not happen.

Declare **Website content** in the data-use section, because the extension
handles it; the declaration is honest even though it never leaves the device.
Certify the limited-use statements.

**Privacy policy URL**:
`https://ceebee.biz.id/privacy/browser-connector`

## Permission justifications

The console asks for one per permission. Paste these:

- **`debugger`** — to act in the page through the Chrome DevTools Protocol
  (`Input.dispatchMouseEvent`, `Runtime.evaluate`, `Page.captureScreenshot`),
  which is how mouse, keyboard, screenshot and console tooling is implemented.
  It is the strongest permission the extension requests and the reason Chrome
  shows its "started debugging this browser" banner.
- **`scripting`** — to read the accessibility snapshot, resolve Page References,
  fill form controls, and upload a file the agent provides.
- **`tabs`** — to enumerate and address the tabs the user has placed under
  control, and to read their URL and title for the panel.
- **`tabGroups`** — controlled tabs are kept in one ephemeral tab group so the
  user can see and close the whole set at once.
- **`storage`** — to keep the paired host, the controlled-tab list, the session
  grants, the audit record, and the last permission mode on the device.
- **`webNavigation`** — to notice top-level navigations, so a Page Reference
  from the previous document is refused instead of resolving against the new one.
- **`sidePanel`** — the Connector Panel is the status and audit view.
- **`nativeMessaging`** — the only way to reach the local MCP server; the
  extension has no server of its own.
- **Host permissions (`http://*/*`, `https://*/*`)** — the extension cannot know
  which sites the user will ask the agent to work in, so it requests all of them.
  Access is still gated by the controlled-tab boundary: a page outside it is
  never read or acted on. Users can narrow this in Chrome's site-access settings.

## Distribution

- **Visibility**: public if you want anyone to find it. *Unlisted* gets the same
  review and the same autoupdate but is not searchable — the reasonable middle
  for a developer tool whose users still install the native host by hand.
- The listing must say the extension needs a separately installed companion
  program; the store ships half the product.

## Console steps

1. **Package** → upload `browser-connector.zip`. The manifest carries no `key`
   (the store rejects one), so the id the console assigns is new. Note it down:
   it is what step 3's `allowed_origins` must name.
2. **Store listing** → name, summary, detailed description, category *Developer
   Tools*, language English, three screenshots, the small promo tile and the
   1400×560 marquee, store icon.
3. **Privacy practices** → single purpose, the justifications above, the data-use
   declaration, the limited-use certifications, and the privacy policy URL.
4. **Distribution** → visibility, and the countries you will ship to.
5. **Submit for review.** Expect longer than usual: broad host permissions and
   `debugger` are the two things the review process names as slow, and
   `javascript_tool` will invite questions about executing agent-supplied code.

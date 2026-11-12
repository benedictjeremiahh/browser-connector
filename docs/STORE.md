# Chrome Web Store submission pack

Use the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
to update the existing Browser Connector item, `joapggeojinhbnphdainoiinicnaaieo`.
Upload the release ZIP and refresh the listing before submitting the update for review.

## Files

| File | Where it goes |
| --- | --- |
| `browser-connector.zip` | **Package → Upload new package.** Build it with `node scripts/package-extension.mjs`. |
| `store/screenshot-1-tab-control.png` (1280×800) | Store listing → Screenshots, first: tab control. |
| `store/screenshot-2-approvals.png` (1280×800) | Store listing → Screenshots, second: approvals. |
| `store/screenshot-3-allowed-sites.png` (1280×800) | Store listing → Screenshots, third: Allowed sites. |
| `store/promo-440x280.png` | Store listing → Small promo tile. |
| `store/promo-marquee-1400x560.png` | Store listing → Marquee promo image. PNG, 24-bit, **no alpha**, which is what the field demands. |
| `extension/public/icons/128.png` | Already inside the package; the console also wants a store icon. |

The three listing screenshots are composed from the 0.5.0 panel captures at
1280×800. When the panel changes, recompose them from a fresh capture instead
of editing the pixels; the store rejects portrait or non-1280×800 images.

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
rather than replacing it. `install` adds an id and never drops one, so running
it a second time is how that is done, and it prints how many ids the manifest
now allows:

```sh
browser-connector install --extension-id kppdjhnonomijdjifhobgeaipejojbho --host-id codex
browser-connector install --extension-id <store-id> --host-id codex
#   allowed extension ids (2): kppdjhnonomijdjifhobgeaipejojbho, <store-id>
```

Chrome reads this file when it opens a native-messaging connection. If the
panel still reports *disconnected* after registering, restart Chrome.

## Store listing

**Name**: Browser Connector

**Summary**: Give a local AI agent access to selected Chrome tabs. A product by ceebee.

**Category**: Developer Tools

Detailed description:

```text
🌐 Browser Connector puts a local AI agent to work in Chrome tabs you pick.

🤖 In a controlled tab, the agent reads pages, captures screenshots, inspects the console and network, and clicks, types, or fills forms. A visible cursor shows where it acts.

🗂️ A tab belongs to one agent session at a time. From the side panel, bring it forward, take control back without closing it, or release all controlled tabs.

🔐 JavaScript and file transfers need approval; each request names the session and target tab when available.

✅ In Allowed sites, add the current site or type an address; you see the exact origin before saving. Allowed sites persist across sessions. Allow only trusted sites: a paired agent can read and change them, including signed-in pages.

🔒 Page content goes to the agent host on your computer over Chrome native messaging. There is no account, hosted backend, or telemetry; the activity log stays local.

📦 Install the companion separately on macOS. With npm (Node.js 18+), run:

npx @ceebee/browser-connector install

Restart Chrome; the panel shows Connected. The repository covers MCP client setup and Homebrew.

A product by ceebee.

https://github.com/benedictjeremiahh/browser-connector
```

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
- **`alarms`** — a local Chrome alarm checks for expired released tabs and orphaned
  blank tabs created by an agent. Chrome keeps the cleanup scheduled while the
  extension service worker sleeps.
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

1. **Package** → upload `browser-connector.zip` to the existing item. The manifest
   carries no development `key`. An update retains the Store extension ID.
2. **Store listing** → name, summary, detailed description, category *Developer
   Tools*, language English, three screenshots, the small promo tile and the
   1400×560 marquee, store icon.
3. **Privacy practices** → single purpose, the justifications above, the data-use
   declaration, the limited-use certifications, and the privacy policy URL.
4. **Distribution** → visibility, and the countries you will ship to.
5. **Submit for review.** Expect longer than usual: broad host permissions and
   `debugger` are the two things the review process names as slow, and
   `javascript_tool` will invite questions about executing agent-supplied code.

## Shipping an update

Check that the listing still describes the current approval and control behavior before
submitting an update.

1. Bump `version` in `extension/public/manifest.json`. The console refuses a
   version that is not higher than the one it already has.
2. Rebuild the package the store receives — never hand over a zip that still
   carries the development `key`, which the console rejects:

   ```sh
   node scripts/package-extension.mjs
   ```

   It prints the version and size it packed, and stops if `extension/dist` has
   no manifest, so a silent bad build cannot reach the console.
3. **Package → Upload new package**, then **Submit for review**. An update does
   not change the store id, so `allowed_origins` needs no edit. Choose automatic
   publication if the release should go live once Google approves it.

The one release that *does* need the native host registered is the first upload
of a given id — see the note above. A review pass is not a test: submitting a
package does not execute it, so run the extension from `extension/dist` before
uploading. `./scripts/install-local.sh` rebuilds both halves, so what you
exercised is what you are about to ship.

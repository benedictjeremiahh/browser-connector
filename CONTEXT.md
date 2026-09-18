# Browser Connector

This context defines the language for connecting an external AI agent to a user-controlled browser without owning the agent or its conversation.

## Language

**Browser Connector**:
A capability bridge that lets an external AI agent observe and operate an authorized browser session. It does not select models, run the agent loop, or own conversations.
_Avoid_: AI client, chatbot, model provider

**Agent Host**:
An external application that owns the agent loop and invokes Browser Connector capabilities on the agent's behalf.
_Avoid_: Model provider, model, Browser Connector

**Native Broker**:
The owner-restricted local process held open by Chrome's native-messaging port. It multiplexes temporary Agent Host connections without owning browser authority; Host Pairing and the Control Lease remain enforced by the extension.
_Avoid_: Cloud relay, agent daemon, Control Lease

**Browser Session**:
A user-selected, visible local browser context whose existing signed-in state may be used within Controlled Tabs without exposing credentials to the agent.
_Avoid_: Headless browser, remote browser, credential store

**Control Lease**:
Exclusive, revocable authority granted to one Agent Host to use a Browser Session for a limited time. Other hosts cannot observe or act through that Browser Session until the lease is released.
_Avoid_: Connection, permanent ownership, concurrent control

**Host Pairing**:
An explicit, locally stored trust relationship between a Browser Connector installation and an Agent Host installation.
_Avoid_: Model login, cloud account, implicit discovery

**Connector Panel**:
The browser side panel where the user observes connections and activity, manages access, and approves consequential actions. It does not contain an AI conversation or model controls.
_Avoid_: Chat panel, AI assistant, conversation view

**Audit Event**:
A local, metadata-only record of a connector request, its outcome, and any user authorization decision. Browser content and sensitive input are excluded by default.
_Avoid_: Conversation history, page archive, telemetry

**Untrusted Browser Content**:
Information obtained from a webpage, console, or network activity that can inform an agent but cannot authorize actions or expand connector access.
_Avoid_: User instruction, trusted command, permission

**Permission Mode**:
The user's chosen approval policy for routine browser changes: Manual asks before every state-changing action, while Auto relies on a Session Grant. Neither mode bypasses Protected or Critical Action approval.
_Avoid_: Host policy, skip-all mode, site permission

**User-only Step**:
A privileged or identity-verifying interaction that the connector must pause for the user to complete without observing or handling its secrets.
_Avoid_: Protected Action, automatable challenge, credential request

**Page Reference**:
An opaque, document-scoped handle to an element exposed through a semantic page snapshot. It becomes invalid when its tab or document generation changes.
_Avoid_: CSS selector, persistent element ID, cross-session reference

**Controlled Tab**:
A browser tab the user has explicitly authorized for agent access, or that the agent created inside an already authorized session. Tabs outside this boundary are not visible to the Browser Connector.
_Avoid_: Active tab, current tab, any tab

**Session Grant**:
Time-bounded permission for an agent to perform approved categories of routine actions on specified sites and Controlled Tabs.
_Avoid_: Permanent permission, unrestricted access

**Site Grant**:
User authorization for routine connector actions on one exact browser origin, scoped to one request, one session, or until explicitly revoked.
_Avoid_: Wildcard access, tab permission, Protected Action approval

**Protected Action**:
An action that always pauses for explicit user approval even when a Session Grant is active, because it can disclose data or create an external consequence.
_Avoid_: Routine action, pre-approved action

**Critical Action**:
A Protected Action with financial or irreversible consequences. It is allowed only after the user receives a consequence-specific warning and explicitly confirms that single action.
_Avoid_: Prohibited action, pre-approved action

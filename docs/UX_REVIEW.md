# VSCode Webview UX Review

Design review by Ran Elimelech (AAP-77888 / ANSTRAT-1891).

This document tracks UX issues identified in the VSCode webviews (Provider
Configuration panel and Chat sidebar) and their resolution status.

---

## UX-001: Add Provider — Button and Form Below the Fold

**Status:** Done  
**Severity:** Medium  
**Affected files:**
- `packages/vscode/src/webview-ui/provider/main.ts`
- `packages/vscode/media/provider.css`

### Problem

The "+ Add Provider" button sits below the provider list. Clicking it expands
an inline accordion form even further down. As providers accumulate the button
and form are pushed off-screen and the user never sees them.

### Review quote

> "Add provider" UI is very weird. It is a button, but then it is also an
> inline form. Furthermore, it is below the list of providers, which can extend
> very long, therefore, be below the fold and the user's awareness.

### Resolution

Convert the add/edit flow from an inline accordion to a **modal dialog** using
the native `<dialog>` element. The "+ Add Provider" button moves above the
provider list. The two-step accordion content (Provider Setup + Select Models)
renders inside the modal body with Save / Cancel footer actions and an X close
button.

---

## UX-002: Edit Provider — Form at Bottom, Wrong Title

**Status:** Done  
**Severity:** Medium-High  
**Affected files:**
- `packages/vscode/src/webview-ui/provider/main.ts`
- `packages/vscode/media/provider.css`

### Problem

Clicking edit on a provider card opens the same inline accordion form at the
bottom of the page — not below the item being edited. The form still looks like
"Add Provider" because it reuses the same accordion with no visual distinction.
Users think the app is broken or that they are adding a new provider instead of
editing the existing one.

### Review quote

> The edit form opens below the entire list (it is the same form as "Add") and
> not below the item you are editing. I still see the "Add" button as a title,
> so I falsely think this is an add provider or the app is buggy.

### Resolution

Solved together with UX-001. The modal dialog displays a clear title —
"Add New Provider" for the add flow and "Edit Provider: {name}" for the edit
flow. The form is no longer positionally tied to the provider list.

---

## UX-003: Chat Interface — Not Discoverable

**Status:** Done  
**Severity:** High  
**Affected files:**
- `packages/vscode/package.json`
- `packages/vscode/src/webview-ui/chat/main.ts`
- `packages/vscode/src/webviews/chat/ChatViewProvider.ts`
- `packages/vscode/src/webview-ui/provider/main.ts`
- `packages/vscode/src/webviews/provider/ProviderPanel.ts`
- `packages/vscode/media/chat.css`

### Problem

The chat is only accessible via the Abbenay activity bar icon on the left
sidebar. There is no entry point from the provider list or any other surface.
Users must already know about it. The reviewer noted that chat interfaces are
conventionally on the right side, that the chat toolbar should offer more
actions (like "Manage providers"), and questioned whether a dedicated activity
bar icon is warranted.

### Review quotes

> Traditionally, chat interfaces are on the right.

> Since we have this as a dedicated item on the toolbar, why not offer more
> actions from a cog, like Manage providers?

> Not sure if this chat deserves a dedicated toolbar item, if it's just a
> fallback.

### Resolution

1. Keep the chat in the **activity bar** (left sidebar) with the dedicated
   Abbenay icon. VS Code does not support declarative `auxiliarybar` placement
   via `package.json`; the secondary sidebar is a user layout preference.
   Users who prefer the chat on the right can drag it there — VS Code
   remembers the layout per workspace.
2. Add a "Start Chatting" button in the provider panel that focuses the chat
   view.
3. Add a gear/cog menu in the chat input toolbar with links to "Configure
   Providers" and "Open Dashboard".
4. Add a `view/title` menu contribution so the chat view's native title bar
   includes a gear icon linking to provider configuration and the dashboard.

---

## UX-004: Dashboard vs VSCode Webview Duplication

**Status:** Deferred  
**Severity:** Strategic / Architectural  
**Affected files:** N/A (product decision)

### Problem

The provider configuration experience is nearly identical between the web
dashboard (served by the daemon at `localhost:8787`) and the VSCode webview.
Both offer the same flow and fields, raising the question of why both exist.

### Review quote

> Also, why is this a duplication of the dashboard? Why do we have both?

### Current rationale

The VSCode webview provides in-editor configuration for users who work entirely
within VS Code. The web dashboard serves users who manage providers outside the
editor (e.g. terminal-only workflows, shared daemon setups, or non-VSCode
clients). Both talk to the same daemon via different transports (gRPC vs HTTP).

### Resolution

Deferred — this is a product-level decision. Options include keeping both with
differentiated scope, removing the webview in favor of the dashboard, or vice
versa. To be revisited once the feature set stabilises.

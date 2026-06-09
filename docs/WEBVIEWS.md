# VS Code Extension Webviews

## Overview

The Abbenay VS Code extension provides two webviews for managing LLM providers and interacting with models directly from the editor.

| Webview | Purpose | Access |
|---------|---------|--------|
| **Provider Configuration** | Set up LLM providers — select engine, enter credentials, discover and enable models | Command palette: "Abbenay: Configure Providers" |
| **Chat Sidebar** | Chat with any configured model — streaming responses, markdown, tool calls, approval gates | Activity bar: Abbenay icon |

## Design Decisions

### Native webviews over iframes

The webviews use VS Code's native webview API rather than embedding an external web dashboard in an iframe. This gives direct access to VS Code theming (CSS variables), the message-passing API, and CSP controls without cross-origin complications.

### Minimal capabilities

Webviews are intentionally thin UI shells. All business logic (provider configuration, model discovery, chat streaming, tool approval) runs in the extension host and communicates with the daemon via gRPC. The webview only handles rendering and user interaction. This reduces the testing surface — webview code is hard to test automatically, so keeping it minimal limits what can break.

### @vscode-elements/elements

Form controls use [`@vscode-elements/elements`](https://vscode-elements.github.io/), a Lit-based web component library that provides native VS Code-styled UI elements. Components like `vscode-button`, `vscode-textfield`, `vscode-single-select`, and `vscode-radio-group` auto-inherit the active VS Code theme — no custom button/input CSS needed.

Accordion sections use custom divs rather than `vscode-collapsible` because the component forces uppercase headings via shadow DOM styles that cannot be overridden.

### Build separation

Webview UI code (`src/webview-ui/`) is bundled by esbuild with `platform: 'browser'` and `format: 'iife'`, separate from the extension host (`platform: 'node'`, `format: 'cjs'`). The webview directory is excluded from `tsc` to avoid Node.js type conflicts in browser code.

## Provider Configuration Panel

A two-step accordion form for managing LLM providers.

### Step 1: Provider Setup
- **Engine selection** — dropdown of available engines (OpenAI, Anthropic, Ollama, etc.)
- **Provider name** — unique identifier with validation
- **Base URL** — shown conditionally when the engine supports a custom endpoint
- **API key storage** — radio toggle between system keychain and environment variable

### Step 2: Select Models
- **Model discovery** — queries the engine API using the entered credentials
- **Dual-list selector** — Available models on the left, Enabled models on the right, with Add/Remove actions
- **Search filter** — narrows the available models list

### Provider list
Configured providers appear as cards showing status (healthy/error/unconfigured), engine badge, and model count with edit/delete actions.

## Chat Sidebar

A Copilot-style chat interface in the activity bar sidebar.

### Message rendering
- User messages appear as right-aligned bubbles
- Assistant messages are left-aligned with an "Abbenay" label
- Markdown rendered via `marked` with `highlight.js` syntax highlighting (TypeScript, Python, Bash, JSON, YAML, XML, CSS)
- Code blocks include a language label and copy button

### Streaming
- Thinking indicator (animated dots) while waiting for the first chunk
- Progressive markdown rendering as chunks arrive
- Smart auto-scroll that pauses when the user scrolls up
- Cancel button to abort active streams

### Tool calls
- Collapsible cards showing tool name, arguments (JSON), and result
- "Running" state with a progress spinner, "Used" state after completion
- Success/error status indicators

### Tool approval gates
- Warning-styled cards that block the stream until the user responds
- Allow / Deny / Abort buttons
- Resolved state shows the decision taken

### Input area
- Auto-resizing textarea with Enter to send, Shift+Enter for newline
- Model selector dropdown (opens upward)
- New session / Delete session controls

## Architecture

```
┌──────────────────────────────────┐
│      Webview (Browser)           │
│  src/webview-ui/provider/main.ts │
│  src/webview-ui/chat/main.ts     │
│  @vscode-elements/elements      │
│  marked + highlight.js           │
└──────────┬───────────────────────┘
           │ postMessage / onMessage
┌──────────▼───────────────────────┐
│    Extension Host (Node.js)      │
│  src/webviews/provider/          │
│    providerHandler.ts            │
│    ProviderPanel.ts              │
│  src/webviews/chat/              │
│    chatHandler.ts                │
│    ChatViewProvider.ts           │
│  src/webviews/shared/            │
│    types.ts (message protocol)   │
│    getWebviewContent.ts          │
└──────────┬───────────────────────┘
           │ gRPC
┌──────────▼───────────────────────┐
│         Daemon                   │
│    Provider management           │
│    Model discovery               │
│    Chat sessions + streaming     │
│    Tool execution                │
└──────────────────────────────────┘
```

## Message Protocol

Webviews and the extension host communicate via typed messages defined in `src/webviews/shared/types.ts`. Each message has a `type` discriminator field.

### Provider messages
`ready` | `getProviders` | `getEngines` | `configureProvider` | `removeProvider` | `discoverModels` | `getConfig` | `setSecret` | `deleteSecret`

### Chat messages
`ready` | `listModels` | `createSession` | `deleteSession` | `sendMessage` | `cancelStream` | `approveToolCall`

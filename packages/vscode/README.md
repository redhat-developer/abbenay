# Abbenay Provider

**Use any LLM with any VS Code extension** — OpenAI, Anthropic, Google, Ollama & more.

## Overview

This VS Code extension connects to the Abbenay daemon and registers configured LLM models with VS Code's Language Model API. Other extensions can then use these models through the standard `vscode.lm` API.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Other VS Code Extensions (e.g., Ansible, custom tools)        │
│                                                                 │
│  const models = await vscode.lm.selectChatModels({             │
│    vendor: 'abbenay'                                            │
│  });                                                            │
│  const response = await models[0].sendRequest(messages, ...);  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Abbenay Extension (this extension)                            │
│                                                                 │
│  • Connects to daemon on activation                            │
│  • Registers models with VS Code Language Model API            │
│  • Provides workspace path via backchannel                     │
│  • Starts daemon if not running                                │
└─────────────────────────────────────────────────────────────────┘
                              │ gRPC (Unix socket)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Abbenay Daemon (TypeScript/Node.js)                             │
│                                                                 │
│  • Handles all LLM provider communication                      │
│  • Manages configuration and secrets                           │
│  • Provides streaming chat responses                           │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### From VS Code Marketplace (Recommended)

Search for **"Abbenay"** in the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
and click Install. Platform-specific builds are provided for Linux x64,
Linux arm64, and macOS arm64.

Or install from the command line:

```bash
code --install-extension redhat.abbenay-provider
```

### From VSIX (Manual)

Download the platform-specific `.vsix` from
[GitHub Releases](https://github.com/redhat-developer/abbenay/releases)
and install manually:

```bash
code --install-extension abbenay-provider-linux-x64-*.vsix
```

### Prerequisites

The Abbenay daemon must be running. If installed via npm:

```bash
aby daemon        # Start the daemon
aby start         # Or start everything (daemon + web + API + MCP)
```

If using the standalone SEA binary, use `./abbenay-daemon daemon` (or
rename/symlink to `aby`).

## Configuration

Provider and model configuration is managed through the **web dashboard**.
VS Code settings control logging and optional **remote gRPC** connection:

| Setting | Purpose |
|---------|---------|
| `abbenay.logLevel` | Extension log level |
| `abbenay.daemonAddress` | Remote gRPC `host:port` (e.g. `127.0.0.1:50051`). Empty = local IPC + auto-start |
| `abbenay.daemonTls` | Use TLS for remote address (default `true`) |
| `abbenay.daemonCaPath` | Path to daemon CA PEM (`tls/ca.crt` from the container runtime dir) |
| `abbenay.daemonSslTargetName` | SSL name override (default `abbenay-grpc`) |
| `abbenay.daemonTokenEnv` | Env var holding consumer token (`x-abbenay-token`) |

Commands **Abbenay: Set Daemon Token** / **Clear Daemon Token** store the
consumer token in VS Code SecretStorage (preferred over putting secrets in
settings.json).

### Remote / container daemon

When Abbenay runs in a container with gRPC published (`-p 50051:50051` and
`--grpc-tls`), point the extension at that port — **not** HTTP `:8787`:

```json
{
  "abbenay.daemonAddress": "127.0.0.1:50051",
  "abbenay.daemonTls": true,
  "abbenay.daemonCaPath": "/path/to/ca.crt",
  "abbenay.daemonTokenEnv": "APME_TOKEN"
}
```

Copy or mount the daemon’s `tls/ca.crt`, configure a matching `consumers`
entry on the daemon, then set the token via SecretStorage or the env var.
With `daemonAddress` set, the extension does **not** auto-start a local SEA.
`daemonAddress` must be `host:port` for **gRPC** (typically `50051`); the
HTTP dashboard port `8787` is rejected. Open Dashboard uses the same host
on `:8787` when a remote address is configured (publish that port too).

### Start the Web Dashboard

```bash
aby web           # Start web dashboard
aby start         # Or start everything at once
```

Open http://127.0.0.1:8787 to:
- Add API keys (stored in system keychain or referenced from environment variables)
- Enable/disable providers
- Select which models to expose

HTTP auth is on by default — use the dashboard login / API token when prompted.
The daemon binds to loopback by default; see
[Security & air-gap](../../docs/SECURITY.md).

### Copilot and other Language Model hosts

When Copilot (or another extension) uses an Abbenay model with tools, set
**Abbenay: Language Model Tool Mode** (`abbenay.lmToolMode`) to **passthrough**
(default). Abbenay returns tool calls to the host for native execution instead
of running them via the backchannel (which prompts on every tool).

Use **auto** only if you need the legacy behavior where Abbenay executes tools
itself.

### Config Files

Configuration is stored in YAML files:

| Location | Purpose |
|----------|---------|
| `~/.config/abbenay/config.yaml` | User-level (global) settings |
| `<workspace>/.config/abbenay/config.yaml` | Workspace-specific settings |

Example config:

```yaml
providers:
  openai:
    engine: openai
    api_key_keychain_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
      gpt-4o-mini: {}
  anthropic:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    models:
      claude-sonnet-4-20250514: {}
```

## Commands

| Command | Description |
|---------|-------------|
| `Abbenay: Show Daemon Status` | Check daemon connection status (includes local vs remote mode) |
| `Abbenay: Open Dashboard` | Open web dashboard in browser |
| `Abbenay: Configure Providers` | Open provider configuration |
| `Abbenay: Set Daemon Token` | Store consumer token in SecretStorage |
| `Abbenay: Clear Daemon Token` | Remove stored consumer token |

## Supported Providers

| Provider | Tool Calling | Vision | Streaming |
|----------|-------------|--------|-----------|
| OpenAI | ✓ | ✓ | ✓ |
| Anthropic | ✓ | ✓ | ✓ |
| Google Gemini | ✓ | ✓ | ✓ |
| Mistral | ✓ | ✗ | ✓ |
| Ollama | ✓ | ✗ | ✓ |
| Azure OpenAI | ✓ | ✓ | ✓ |
| OpenRouter | ✓ | ✓ | ✓ |
| DeepSeek | ✓ | ✗ | ✓ |
| Groq | ✓ | ✗ | ✓ |

## Using Abbenay Models from Other Extensions

Other extensions can use Abbenay models through the standard VS Code Language Model API:

```typescript
import * as vscode from 'vscode';

// Get Abbenay models
const models = await vscode.lm.selectChatModels({
  vendor: 'abbenay'
});

if (models.length > 0) {
  const messages = [
    vscode.LanguageModelChatMessage.User('Hello!')
  ];
  
  const response = await models[0].sendRequest(messages, {}, token);
  
  for await (const chunk of response.text) {
    console.log(chunk);
  }
}
```

## Extension Architecture

The extension is a thin gRPC client with these responsibilities:

| Component | Description |
|-----------|-------------|
| **Daemon Client** | Connects via local IPC (Unix socket / loopback) or remote gRPC `host:port` |
| **Backchannel** | Provides workspace path to daemon for workspace-level config |
| **LM Provider** | Implements `LanguageModelChatProvider` to register models with VS Code |
| **Chat Sidebar** | Provides chat view in the activity bar |

The extension does **not**:
- Store provider API keys (those live in the daemon keychain / env)
- Store provider configuration (config is in YAML files / dashboard)
- Make direct HTTP calls to LLM providers (daemon handles this)

Optional: consumer token for remote gRPC may be stored in VS Code SecretStorage.

## Development

```bash
cd packages/vscode

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Package to VSIX
npm run package

# Press F5 in VS Code to debug
```

## Troubleshooting

### Extension Not Connecting

1. Check if daemon is running:
   ```bash
   pgrep -f "abbenay daemon"
   ```

2. Check socket exists:
   ```bash
   ls -la /run/user/$(id -u)/abbenay/daemon.sock
   ```

3. Restart daemon:
   ```bash
   aby stop
   aby daemon
   ```

4. Check Output panel: View → Output → "Abbenay Provider"

5. For a container / remote daemon: confirm `abbenay.daemonAddress` is
   `host:50051` (gRPC), not `:8787` (HTTP). Verify TLS CA path, consumer
   token, and that port `50051` is published. Status shows
   `remote:host:port (tls)`.

### Models Not Appearing

1. Open web dashboard (http://127.0.0.1:8787) — sign in with the API token if prompted
2. Ensure provider has valid API key
3. Enable the models you want
4. Reload VS Code window

## License

MIT

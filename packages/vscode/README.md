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

### From VSIX

```bash
cd packages/vscode
npm install
npm run package
code --install-extension abbenay-provider-0.1.0.vsix
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

Provider and model configuration is managed through the **web dashboard**,
not VS Code settings. The extension contributes only `abbenay.logLevel`
as a VS Code setting.

### Start the Web Dashboard

```bash
aby web           # Start web dashboard
aby start         # Or start everything at once
```

Open http://localhost:8787 to:
- Add API keys (stored in system keychain or referenced from environment variables)
- Enable/disable providers
- Select which models to expose

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
| `Abbenay: Show Daemon Status` | Check daemon connection status |
| `Abbenay: Open Dashboard` | Open web dashboard in browser |
| `Abbenay: Configure Provider` | Open provider configuration |

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
| **Daemon Client** | Connects to the Abbenay daemon via Unix socket |
| **Backchannel** | Provides workspace path to daemon for workspace-level config |
| **LM Provider** | Implements `LanguageModelChatProvider` to register models with VS Code |
| **Status Bar** | Shows connection status |

The extension does **not**:
- Store secrets (secrets are in system keychain)
- Store configuration (config is in YAML files)
- Make direct HTTP calls to LLM providers (daemon handles this)
- Provide a chat UI (use the web dashboard or other extensions)

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

### Models Not Appearing

1. Open web dashboard (http://localhost:8787)
2. Ensure provider has valid API key
3. Enable the models you want
4. Reload VS Code window

## License

MIT

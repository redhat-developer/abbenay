# AI Gateway & LLM Routing Landscape

A fair comparison of open-source projects that solve multi-provider LLM
routing, and where Abbenay fits among them.

Last updated: March 2026

---

## Projects Compared

| Project | Stars | Language | License |
|---------|-------|----------|---------|
| [LiteLLM](https://github.com/BerriAI/litellm) | ~38k | Python | MIT |
| [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) | ~11k | TypeScript | MIT |
| [LLM Gateway](https://github.com/theopenco/llmgateway) | ~950 | TypeScript | AGPL-3 / Enterprise |
| [ngrok](https://ngrok.com/) | N/A (SaaS) | Go | Proprietary |
| Abbenay | Early | TypeScript | Apache-2.0 |

---

## Architecture Models

### Centralized Proxy (LiteLLM, Portkey, LLM Gateway)

All three follow the same pattern: deploy a proxy server, point your
application at it instead of the LLM provider, and the proxy handles
routing, retries, caching, and observability.

```
┌──────────┐      ┌──────────────┐      ┌──────────────┐
│  Your    │─────▶│  AI Gateway  │─────▶│  LLM Provider│
│  App     │◀─────│  (proxy)     │◀─────│  (OpenAI,...)│
└──────────┘      └──────────────┘      └──────────────┘
```

**Strengths:** centralized cost tracking, team-wide policy enforcement,
single point for logging and guardrails, easy to add to existing apps
via base URL swap.

**Trade-offs:** extra infrastructure to deploy and operate, network hop
adds latency, proxy becomes a single point of failure, secrets must be
stored in the proxy.

### Tunnel / Edge Gateway (ngrok)

ngrok is a networking platform, not an LLM-specific tool. It exposes
local services to the internet via secure tunnels. Their newer AI
Gateway product adds LLM-specific traffic policies (rate limiting, WAF,
routing) at the edge.

**Strengths:** zero-config public URLs for local development, built-in
DDoS protection, traffic inspection, useful for exposing local MCP
servers to remote clients.

**Trade-offs:** not an LLM routing layer on its own, requires a
separate LLM client/gateway behind it, SaaS pricing model.

### Embeddable Library + Local Daemon (Abbenay)

Abbenay takes a different approach: a reusable core library
(`@abbenay/core`) that can be embedded directly in any Node.js process,
plus an optional daemon that adds gRPC transport, MCP server
aggregation, and a web dashboard.

```
┌─────────────────────────────────────────────────┐
│  Your App / CLI / VS Code Extension             │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  @abbenay/core (in-process)             │    │
│  │  Engine routing, streaming, policies    │────▶ LLM Providers
│  │  Config, secrets (injected)             │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

**Strengths:** no infrastructure to deploy, works offline with local
models, secrets stay on the developer's machine, same core powers CLI /
daemon / extension / web, in-process tool execution with approval
policies.

**Trade-offs:** not designed for team-wide centralized control, no
built-in cost tracking or billing, earlier in development.

---

## Feature Comparison

| Capability | LiteLLM | Portkey | LLM Gateway | Abbenay |
|------------|---------|---------|-------------|---------|
| **Built-in engines** | 100+ | 250+ | ~15 | 19 + any OpenAI-compatible¹ |
| **OpenAI-compatible API** | Yes | Yes | Yes | Yes (`/v1/chat/completions`)² |
| **Embeddable library** | Python SDK | No | No | Yes (`@abbenay/core`) |
| **Standalone daemon** | Proxy server | Proxy server | Proxy server | Optional daemon |
| **Session persistence** | No | No | No | Yes (file-based + summaries) |
| **CLI chat** | No | No | No | Yes |
| **VS Code integration** | No | No | No | Language Model API |
| **MCP tool aggregation** | MCP Gateway | MCP Gateway | No | MCP client pool |
| **Tool approval policies** | No | No | No | Yes (per-tool tiers) |
| **Streaming** | Yes | Yes | Yes | Yes (Vercel AI SDK) |
| **Retries / fallbacks** | Yes | Yes | Limited | Limited (JSON retry) |
| **Load balancing** | Yes | Yes | No | Not yet |
| **Caching** | Simple + semantic | Simple + semantic | No | Not yet |
| **Guardrails** | Via plugins | 50+ built-in | No | Via policies |
| **Cost tracking** | Yes | Yes | Yes | Not yet |
| **Team / RBAC** | Enterprise | Enterprise | Enterprise | Not yet |
| **Local model support** | Ollama, vLLM | Ollama | No | Ollama, LM Studio |
| **SEA binary** | No | No | No | Yes (single executable) |
| **Config format** | YAML | JSON / API | Web UI | YAML (user + workspace) |

---

## When to Use What

**Use LiteLLM** when you need a battle-tested Python proxy with the
widest provider support, enterprise features, and you're comfortable
running centralized infrastructure. Good for platform teams serving
multiple internal consumers.

**Use Portkey** when you want a fast TypeScript proxy with built-in
guardrails, load balancing, and an MCP Gateway for managing MCP servers
across an organization. Strong enterprise offering.

**Use LLM Gateway** when you want a lightweight, self-hosted proxy with
usage analytics and a clean dashboard. Smaller project, fewer features,
but simpler to operate.

**Use ngrok** when you need to expose a local service (including
Abbenay's daemon or a local MCP server) to the internet for development,
demos, or webhook testing. Complements rather than replaces an LLM
router.

**Use Abbenay** when you want an embeddable library for your Node.js
app, a developer workstation daemon with CLI chat and VS Code
integration, or in-process tool execution with approval policies. Best
for individual developers and small teams who want to keep secrets local
and avoid deploying proxy infrastructure.

---

## Complementary Use

These tools are not mutually exclusive. Example combinations:

- **Abbenay + ngrok**: Expose the Abbenay web dashboard or MCP server to
  a remote collaborator during pair programming.
- **Abbenay + LiteLLM**: Use LiteLLM as a centralized proxy for
  team-wide cost tracking, with Abbenay as the developer-facing tool
  that routes through it via a custom `base_url`.
- **Abbenay + Portkey**: Use Portkey's MCP Gateway for org-wide MCP
  server management, while developers use Abbenay locally for chat and
  tool approval workflows.

---

## Footnotes

¹ Abbenay ships 19 pre-configured engines (OpenAI, Anthropic, Gemini,
Mistral, xAI, DeepSeek, Groq, Cohere, Amazon Bedrock, Fireworks,
Together AI, Perplexity, Azure, OpenRouter, Ollama, LM Studio, Cerebras,
Meta, Mock). Any provider that exposes an OpenAI-compatible REST API can
be used by pointing a configured engine's `base_url` at it — no code
changes required.

² Abbenay exposes an OpenAI-compatible API at `/v1/models` and
`/v1/chat/completions` (streaming and non-streaming). Any tool that
speaks the OpenAI protocol (Cursor, Continue, aider, `openai` SDK
scripts) can use Abbenay as a drop-in backend via the `serve` command
(e.g., `aby serve` if installed via npm, or `./abbenay-daemon serve`
for the standalone binary). Client access is also available via the
`@abbenay/core` library (in-process), gRPC (daemon), REST API
(`/api/*`), or the CLI.

---

## Notes on Methodology

- Star counts are approximate as of March 2026.
- Feature comparisons are based on public documentation and README files.
- "Not yet" means the feature is planned or on the roadmap, not that it
  is architecturally impossible.
- This document aims to be objective. Contributions and corrections are
  welcome.

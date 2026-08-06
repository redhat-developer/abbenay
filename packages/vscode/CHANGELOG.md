# Changelog

All notable changes to the Abbenay Provider extension will be documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [CalVer](https://calver.org/) versioning (`YYYY.M.MICRO`).

## [Unreleased]

### Security

- **Secure-by-default HTTP (AAP-82788 / DR-030):** bind defaults to `127.0.0.1`
  (not `0.0.0.0`); Bearer / dashboard auth required on `/api/*`, `/v1/*`, and
  `/mcp`; CORS is an explicit allowlist (never `*`).
- **Fail-closed gRPC TCP (AAP-82804 / DR-029):** non-loopback binds require
  `--grpc-tls` or explicit `--insecure`; empty `consumers` refused off-loopback
  unless `--allow-open-auth` / `--insecure`.
- **Air-gap docs (AAP-82838 / A4 / DR-038):** product copy no longer implies
  network isolation alone secures Abbenay. See
  [SECURITY.md](../../docs/SECURITY.md) for defaults, residual risks, and the
  operator checklist (bind, auth, CORS, TLS, consumers, MCP).

### Added

- Initial VS Code Marketplace release
- Language Model API provider for all configured LLM backends
- Activity bar with chat webview
- Automatic daemon lifecycle management (start on activate, stop on deactivate)
- Provider configuration webview
- Support for OpenAI, Anthropic, Google Gemini, Mistral, Ollama, Azure OpenAI,
  OpenRouter, DeepSeek, and Groq
- Platform-specific builds for Linux x64, Linux arm64, and macOS arm64

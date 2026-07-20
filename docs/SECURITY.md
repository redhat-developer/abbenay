# Security, Privacy, and Air-Gap

Abbenay can use **local / on-prem models** (Ollama, Red Hat AI Inference
Server, LM Studio, and similar) so prompts need not leave your network.
That is a **data-routing** property — not authentication, authorization, or
TLS.

> **Network isolation alone does not secure Abbenay.**
> An air-gapped or offline host can still expose a reachable daemon to every
> local process and every client that can contact the bind address. Do not
> treat “no internet” as a substitute for the defaults below.

Code fixes for the historical gaps (all-interface HTTP, wildcard CORS,
plaintext gRPC off-loopback) live in DR-030 / AAP-82788 and DR-029 /
AAP-82804. This page aligns product claims with that posture (finding A4).

Config details: [CONFIGURATION.md](./CONFIGURATION.md). Containers:
[CONTAINER.md](./CONTAINER.md).

---

## Default posture (after secure defaults)

| Control | Default |
|---------|---------|
| **HTTP bind** | `127.0.0.1` (not `0.0.0.0`) |
| **HTTP auth** | Required (Bearer / dashboard session) |
| **CORS** | Explicit allowlist — never `*` |
| **gRPC TCP** | Loopback plaintext OK; non-loopback needs `--grpc-tls` or `--insecure` |

### What this addresses from finding A4

| Historical issue | Current posture |
|------------------|-----------------|
| HTTP on `0.0.0.0` (H1) | Binds `127.0.0.1` |
| Wildcard CORS (C1) | Allowlist only; auth required |
| Plaintext gRPC when exposed (C2) | TLS (or explicit `--insecure`) off-loopback |
| No network isolation controls | **Not a product feature** — see below |

### No network isolation controls (by design)

Abbenay does **not** provide firewall, VLAN, offline-enforcement, or other
network-isolation features. Air-gap / offline networking is an **operator /
environment** concern (host firewall, air-gapped NIC, no default route, etc.).

What Abbenay *does* provide are daemon exposure controls:

| Control | Role |
|---------|------|
| **Bind address** | Limits which interfaces accept connections |
| **HTTP auth** | Blocks anonymous API / dashboard / MCP access |
| **CORS allowlist** | Stops arbitrary websites from calling the daemon in a browser |
| **gRPC TLS / `--insecure`** | Protects or explicitly opts out of encryption off-loopback |
| **Consumers** (gRPC) | Capability tokens for non-loopback gRPC clients |

Documenting these is how A4 is closed — not by inventing an isolation product.
Operators who need isolation must apply it outside Abbenay **and** keep these
defaults (or stronger) in place.

### Residual risks even when air-gapped

- Same-user local processes can still reach loopback / Unix sockets.
- Stolen API or consumer tokens still work.
- `--host 0.0.0.0`, `ABBENAY_HTTP_AUTH=0`, and `--insecure` deliberately weaken posture.
- Cloud providers still receive prompts if you configure them.
- HTTP on loopback remains plaintext; use a TLS-terminating proxy when exposing beyond the machine.

---

## Decision references

| Decision | Topic |
|----------|--------|
| DR-029 | Fail-closed TLS for non-loopback gRPC TCP |
| DR-030 | Secure-by-default HTTP (auth, CORS, bind) |
| DR-038 | Air-gap docs must not claim isolation equals security |

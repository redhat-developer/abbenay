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
[CONTAINER.md](./CONTAINER.md). Verify a live deploy with the
[operator checklist](#operator-checklist) below.

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

## Operator checklist

Run these after a fresh default start (`aby web` or `abbenay daemon` with no
host/TLS override). Replace `8787` if you use another HTTP port. Load the API
token from `ABBENAY_API_TOKEN` or the auto-generated `http-api-token` file in
the config directory (`~/Library/Application Support/abbenay` on macOS,
`~/.config/abbenay` on Linux, `%APPDATA%\abbenay` on Windows).

```bash
export ABBENAY_API_TOKEN="${ABBENAY_API_TOKEN:-$(cat "$HOME/Library/Application Support/abbenay/http-api-token" 2>/dev/null || cat "$HOME/.config/abbenay/http-api-token")}"
```

### 1. Bind address

Confirm HTTP listens on loopback only (not `0.0.0.0`):

```bash
# macOS / BSD
lsof -nP -iTCP:8787 -sTCP:LISTEN
# Linux
ss -ltnp 'sport = :8787'
```

**Pass:** listener address is `127.0.0.1:8787` (or `[::1]:8787`).
**Fail:** `*:8787`, `0.0.0.0:8787`, or a LAN IP without an intentional `--host` opt-in.

### 2. HTTP auth

```bash
# Unauthenticated API → 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/health
# Authenticated → 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $ABBENAY_API_TOKEN" \
  http://127.0.0.1:8787/api/health
```

**Pass:** first prints `401`, second prints `200`.
**Fail:** unauthenticated request succeeds, or auth cannot be satisfied with the token.

### 3. CORS allowlist

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Origin: https://evil.example' \
  -H "Authorization: Bearer $ABBENAY_API_TOKEN" \
  http://127.0.0.1:8787/api/health

curl -s -D - -o /dev/null \
  -H 'Origin: http://127.0.0.1:8787' \
  -H "Authorization: Bearer $ABBENAY_API_TOKEN" \
  http://127.0.0.1:8787/api/health | grep -i access-control-allow-origin
```

**Pass:** foreign Origin returns `403` and no `Access-Control-Allow-Origin: *`;
localhost Origin is echoed in `Access-Control-Allow-Origin`.
**Fail:** response allows `*` or accepts an arbitrary website Origin.

### 4. gRPC TLS (exposure path)

Default daemon has no TCP gRPC listener. When you enable TCP:

```bash
# Loopback plaintext OK
abbenay daemon --grpc-port 50051
# Must fail without TLS or --insecure
abbenay daemon --grpc-port 50051 --grpc-host 0.0.0.0
# Must succeed only with explicit opt-in (+ consumers; see step 5)
abbenay daemon --grpc-port 50051 --grpc-host 0.0.0.0 --grpc-tls
```

**Pass:** non-loopback without `--grpc-tls` / `--insecure` refuses to start;
with `--grpc-tls`, logs show TLS (see [DEVELOPMENT.md](./DEVELOPMENT.md)).
**Fail:** plaintext gRPC accepts connections on `0.0.0.0` without `--insecure`.

### 5. Consumers (gRPC)

On non-loopback TCP, an empty/missing `consumers` section must refuse to start
unless `--allow-open-auth` or `--insecure` is set. Configure consumers per
[CONFIGURATION.md](./CONFIGURATION.md#consumer-authentication-consumers), then:

```bash
# After consumers + --grpc-tls on 0.0.0.0: sensitive RPCs need x-abbenay-token
# Wrong/missing token → PERMISSION_DENIED (see consumer-auth tests / client docs)
```

**Pass:** start fails with empty consumers on `0.0.0.0`; with consumers, wrong
token is denied on gated RPCs.
**Fail:** non-loopback gRPC allows all callers with no consumers and no opt-in.

### 6. MCP HTTP endpoint

```bash
# Unauthenticated /mcp → 401
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

**Pass:** `401` without Bearer. With Bearer, connection consent is still
required before a session is issued (`GET/POST /api/mcp/connections` — see
[CONFIGURATION.md](./CONFIGURATION.md#mcp-client-connection-consent)).
**Fail:** anonymous clients can open `/mcp` or skip consent.

### Operator controls outside Abbenay

These are **not** product features; confirm them in your environment if you
need air-gap / offline posture:

- Host firewall / security groups restrict who can reach any non-loopback bind
- No unintended default route / NIC bridging for offline hosts
- Strong tokens set via env (`ABBENAY_API_TOKEN`, consumer `token_env`) in
  containers — do not rely on auto-generated files alone

---

## Decision references

| Decision | Topic |
|----------|--------|
| DR-029 | Fail-closed TLS for non-loopback gRPC TCP |
| DR-030 | Secure-by-default HTTP (auth, CORS, bind) |
| DR-038 | Air-gap docs must not claim isolation equals security |

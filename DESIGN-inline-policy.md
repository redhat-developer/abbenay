# Design: Inline Policy Override on ChatRequest

## Status

Accepted — see DR-023 and DR-024 in `docs/decisions.md`.

## Problem

Abbenay's policy system currently only supports **config-time** policy assignment: a virtual model in `config.yaml` references a named policy, and that policy's behavioral defaults are applied to every chat request for that model.

```yaml
# Current: policy bound to model at config time
providers:
  openai:
    engine: openai
    models:
      gpt-4o:
        policy: json_strict   # static binding
```

There is no way for a gRPC caller to specify or override a policy at **request time**. This creates friction for programmatic clients that need specific behavioral guarantees (structured output format, deterministic sampling, retry semantics) without requiring the user to pre-configure virtual model aliases for each use case.

## Motivation: APME (Ansible Policy & Modernization Engine)

APME is a multi-service system that automates policy enforcement and modernization of Ansible content. Its remediation engine classifies violations into tiers:

- **Tier 1**: Deterministic transforms (regex, AST manipulation) — handled today
- **Tier 2**: AI-proposable fixes — requires LLM integration
- **Tier 3**: Manual review

For Tier 2, APME needs to send Ansible-specific remediation requests to an LLM via Abbenay's `Chat` RPC. Each request requires:

- `json_only` output format (structured response for automated parsing)
- `temperature: 0.0` (deterministic fixes, not creative)
- `retry_on_invalid_json: true` (reliability for automated pipelines)
- A domain-specific system prompt snippet about Ansible YAML remediation
- `max_tokens` that varies by file size

Today, APME would need to either:

1. **Create a virtual model alias** in the user's Abbenay config with a custom policy — adds setup friction and couples APME releases to Abbenay config state
2. **Use `ChatOptions` fields only** — loses `json_only` format enforcement, `retry_on_invalid_json`, and `system_prompt_snippet` which are policy-only features
3. **Use the built-in `json_strict` policy** — but it has `temperature: 0.2` (not 0.0), a generic system prompt, and fixed `max_tokens: 2048`

None of these options let APME fully control its behavioral requirements at request time while keeping user setup minimal (just a provider + API key).

## Proposal

Add an optional `PolicyConfig` field to `ChatRequest` (and `SessionChatRequest`) that allows callers to specify an inline policy override at request time.

### Proto Change

```protobuf
message ChatRequest {
  string model = 1;
  repeated Message messages = 2;
  ChatOptions options = 3;
  repeated Tool tools = 4;
  optional PolicyConfig policy = 5;       // NEW: inline policy override
}

message SessionChatRequest {
  string session_id = 1;
  Message message = 2;
  ChatOptions options = 3;
  optional PolicyConfig policy = 4;       // NEW: inline policy override
}
```

The `PolicyConfig` message already exists in the proto (used by `PolicyInfo` for the `ListPolicies` RPC). No new message types are needed.

### Resolution Order

The policy source is either the inline `PolicyConfig` from the request or the named policy from model config — **never both**. The inline policy **fully replaces** the named policy; there is no field-level merge between them.

```
Per-request ChatOptions  >  Model config  >  Policy (inline OR named)  >  Engine defaults
     (field 3)              (config.yaml)     (field 5 or policies.yaml)
```

**Full replacement, not merge:** If a caller sends `{ sampling: { temperature: 0.0 } }` as the inline policy, they do **not** inherit the named policy's `output`, `reliability`, or other fields. Rationale:

- **Hermetic behavior** — the caller's behavior is fully determined by what they send, regardless of server-side config. A service like APME should not break because an admin changed the named policy on a model.
- **No hidden coupling** — merge semantics would create an implicit dependency on a named policy the caller may not know about or control.
- **Simplicity** — an if/else is easier to implement, test, and reason about than recursive field merging with precedence rules.

If merge-on-top-of-named is ever needed, Alternative 3 below provides a clean path.

Concretely, in `core/state.ts` the `chat()` method currently does:

```typescript
// Current (line 572)
const flatPolicy = modelCfg?.policy ? resolveFlatPolicy(modelCfg.policy) : undefined;
```

This becomes:

```typescript
let flatPolicy: FlattenedPolicy | undefined;
if (inlinePolicy) {
  flatPolicy = flattenPolicy(inlinePolicy);
} else if (modelCfg?.policy) {
  flatPolicy = resolveFlatPolicy(modelCfg.policy);
}
```

The rest of the merge chain (`combineSystemPrompts`, `mergeParams`, `ChatOptions` override) remains unchanged. `ChatOptions` fields (temperature, max_tokens, etc.) still override everything, preserving backward compatibility.

### What This Enables

With the inline policy, APME sends a single self-contained request:

```protobuf
ChatRequest {
  model: "openai/gpt-4o"
  messages: [
    { role: SYSTEM, content: "..." },
    { role: USER, content: "Fix this Ansible violation..." }
  ]
  policy: {
    sampling: { temperature: 0.0 }
    output: {
      format: "json_only"
      max_tokens: 2048
      system_prompt_snippet: "You are an Ansible remediation engine. Given a violation and YAML context, return a JSON object with: rule_id, fixed_yaml, explanation, confidence (0-1). Preserve comments. Maintain indentation."
      system_prompt_mode: "prepend"
    }
    reliability: {
      retry_on_invalid_json: true
      timeout: 30000
    }
  }
}
```

The user's only setup: install Abbenay, configure a provider with an API key, point APME at the endpoint. No virtual model aliases, no custom policies, no APME-specific Abbenay configuration.

### Python Client Change

The `AbbenayClient.chat()` method gains an optional `policy` parameter that accepts either a proto `PolicyConfig` or a plain dict:

```python
async def chat(
    self,
    model: str,
    message: str,
    *,
    system: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    enable_tools: bool = False,
    policy: Optional[Union[PolicyConfig, dict]] = None,    # NEW
) -> AsyncIterator[ChatChunk]:
```

When `policy` is a dict, it is converted to a `PolicyConfig` proto via `google.protobuf.json_format.ParseDict`. This lets callers avoid constructing proto objects directly:

```python
# Dict form — friendlier for most Python callers
await client.chat("openai/gpt-4o", "Fix this...", policy={
    "sampling": {"temperature": 0.0},
    "output": {"format": "json_only", "max_tokens": 2048},
    "reliability": {"retry_on_invalid_json": True},
})
```

### gRPC Service Change

In `daemon/server/abbenay-service.ts`, the `Chat` handler extracts the inline policy from the request and passes it to `state.chat()`:

```typescript
// In Chat handler
const inlinePolicy = request.policy
  ? protoToPolicyConfig(request.policy)
  : undefined;

// Pass to state.chat() as new parameter
yield* state.chat(model, messages, requestParams, toolOptions, toolExecutor, inlinePolicy);
```

The `protoToPolicyConfig` helper converts the proto `PolicyConfig` message to the internal `PolicyConfig` TypeScript interface. It validates enum-like string fields (`format`, `system_prompt_mode`, `tool_mode`, `compression_strategy`) and returns a gRPC `INVALID_ARGUMENT` error for unrecognized values.

## Scope of Changes

| File | Change |
|------|--------|
| `proto/abbenay/v1/service.proto` | Add `optional PolicyConfig policy` to `ChatRequest` and `SessionChatRequest` |
| `packages/daemon/src/core/state.ts` | Accept `inlinePolicy` param in `chat()`, use it in resolution chain |
| `packages/daemon/src/daemon/state.ts` | Thread `inlinePolicy` through `DaemonState.chat()` to `super.chat()` |
| `packages/daemon/src/daemon/server/abbenay-service.ts` | Extract inline policy, add `protoToPolicyConfig` helper, consumer auth check |
| `packages/daemon/src/core/config.ts` | Add `ConsumerConfig`, `ConsumerCapabilities` interfaces; extend `ConfigFile` |
| `packages/python/src/abbenay_grpc/client.py` | Add `policy` parameter (proto or dict) to `chat()` method |
| `packages/daemon/src/state.test.ts` | Test inline policy resolution, consumer auth, field validation |

## Backward Compatibility

- **Fully backward compatible.** The new field is `optional`. Existing clients that do not send it get the same behavior as today (named policy from model config, or no policy).
- The resolution chain only adds a new layer; it does not change existing layers.
- No config file format changes.
- No changes to `ListPolicies`, `GetPolicy`, or any other existing RPCs.

## Security Considerations

Inline policy includes `system_prompt_snippet` with a `system_prompt_mode: "replace"` option that can completely override the admin's intended system prompt. This is a prompt injection vector if the gRPC endpoint is reachable by untrusted clients.

### Consumer Authorization Model

To mitigate this, a `consumers` section in `config.yaml` gates inline policy access:

```yaml
consumers:
  apme:
    token_env: APME_ABBENAY_TOKEN      # env var holding the consumer's token
    capabilities:
      inline_policy: true               # allowed to send PolicyConfig on ChatRequest
```

**Behavior:**

- **No `consumers` section (default):** Inline policy is allowed for all callers. This preserves frictionless operation for single-user local deployments.
- **`consumers` section present:** Only callers that pass a valid token via the `x-abbenay-token` gRPC metadata header and whose consumer entry has `inline_policy: true` can use inline policy. Unauthorized requests with an inline policy receive `PERMISSION_DENIED`.

The consumer model provides per-app granularity — the admin can trust APME without trusting all Python clients. Token-based auth was chosen over client-type gating for this reason (see DR-024).

## Alternatives Considered

### Alternative 1: Named Policy Reference on ChatRequest

Add `optional string policy_name` to `ChatRequest` instead of an inline `PolicyConfig`. The caller references a named policy (built-in or custom) by name.

**Rejected**: Still requires pre-configured policies. Doesn't solve the setup friction problem — the caller would need the user to create a custom policy in `policies.yaml`, or be limited to built-in policies that may not match their requirements.

### Alternative 2: Expand ChatOptions to Cover All Policy Fields

Add `format`, `system_prompt_snippet`, `retry_on_invalid_json`, etc. directly to `ChatOptions`.

**Rejected**: `ChatOptions` is for per-request parameter overrides (sampling, tokens, tools). Mixing in policy-level concerns (output format, reliability, system prompt composition) conflates two different abstraction layers. Policies are coherent bundles of behavior; `ChatOptions` is individual knobs.

### Alternative 3: Both Named and Inline

Add both `optional string policy_name` and `optional PolicyConfig policy` to `ChatRequest`, with inline taking priority over named.

**Viable but unnecessary for the initial implementation.** Can be added later if there's demand for referencing named policies at request time.

## Resolved Questions

1. **Should `SessionChatRequest` also support inline policy?** Yes — the `optional PolicyConfig policy` field is added to the proto now for forward compatibility. `SessionChat` is currently unimplemented; the per-message vs. session-creation-time semantic will be decided when sessions are built.

2. **Should there be validation when inline policy conflicts with `ChatOptions`?** No gRPC-level error. The resolution order is deterministic (`ChatOptions` wins), so there is no ambiguity. A debug-level log is emitted when both set the same field, which is sufficient for diagnosing unexpected behavior without blocking legitimate use (e.g., inline policy sets a baseline, `ChatOptions` overrides one field).

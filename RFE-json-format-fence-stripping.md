# RFE: json_only Format Should Accept Fenced JSON

**Filed by**: APME integration testing  
**Priority**: Medium — causes double LLM calls on every request  
**Component**: `packages/daemon` (policy enforcement / output format)

---

## Summary

The `json_only` output format policy rejects valid JSON responses that are
wrapped in markdown code fences. Most LLMs (including Claude) habitually
wrap JSON responses in `` ```json ... ``` `` fences even when explicitly
instructed not to. This causes every request to fail validation and retry,
doubling LLM costs and latency.

---

## Current Behavior

When a consumer sends a policy with `output.format: "json_only"`:

1. LLM returns: `` ```json\n{"patches": [...]}\n``` ``
2. Abbenay's `json_strict` validator rejects it ("not valid JSON")
3. If `retry_on_invalid_json: true`, Abbenay retries the same prompt
4. Second attempt may or may not include fences (non-deterministic)
5. If it passes, the response is forwarded to the consumer

From the daemon logs during APME testing (9 sequential batch calls):

```
[State] json_strict: response is not valid JSON (14820 chars). Retrying once.
[State] json_strict: response is not valid JSON (14234 chars). Retrying once.
[State] json_strict: response is not valid JSON (10248 chars). Retrying once.
... (all 9 chunks required retries)
```

**Result**: 18 LLM calls instead of 9, ~$2.16 instead of ~$1.08, ~10
minutes instead of ~5 minutes.

---

## Proposed Behavior

Before running JSON validation, strip common LLM response wrappers:

1. Leading/trailing whitespace
2. Markdown code fences: `` ```json ... ``` `` or `` ``` ... ``` ``
3. Optional: leading prose before the first `{` or `[`

Then validate the cleaned content as JSON.

### Suggested implementation

```typescript
function cleanJsonResponse(raw: string): string {
  let cleaned = raw.trim();

  // Strip markdown fences
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    // Remove first line (```json or ```)
    lines.shift();
    // Remove last line if it's ```)
    if (lines.length && lines[lines.length - 1].trim() === '```') {
      lines.pop();
    }
    cleaned = lines.join('\n').trim();
  }

  return cleaned;
}
```

This should be applied in the `json_strict` validator before
`JSON.parse()`, so the retry is only triggered for genuinely malformed
responses.

---

## Impact

- Cuts LLM call count in half for `json_only` consumers
- Halves latency and cost for JSON-heavy workflows
- No change needed on the consumer side
- Backward compatible — responses that are already valid JSON pass through
  unchanged

---

## Alternatives Considered

**Consumer-side workaround**: APME can drop `json_only` from the policy and
parse JSON itself (including fence stripping). This works but defeats the
purpose of server-side format enforcement and pushes validation burden to
every consumer.

**New format mode**: Add `json_lenient` alongside `json_only` that accepts
fenced JSON. This preserves strict mode for consumers that want it.

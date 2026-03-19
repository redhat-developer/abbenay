# RFE: Python Client Packaging Issues

**Filed by**: APME integration testing  
**Priority**: High — blocks clean consumer integration  
**Component**: `packages/python` (`abbenay-client` / `abbenay_grpc`)

---

## Summary

The `abbenay_grpc` Python client has several packaging issues that force
consumers to apply non-standard workarounds to import and use it correctly.
These were discovered during APME's AI escalation integration.

---

## Issue 1: Generated proto stubs use absolute imports from wrong root

**Problem**

`proto/generate.sh` runs `protoc --python_out` with the output directory set
to `packages/python/src/abbenay_grpc/`. This produces generated stubs like:

```python
# service_pb2_grpc.py (generated)
from abbenay.v1 import service_pb2 as abbenay_dot_v1_dot_service__pb2
```

This is an **absolute import from `abbenay.v1`**, which only resolves if
`abbenay_grpc/` itself is on `sys.path`. But when the package is installed
via pip, `site-packages/` is on `sys.path`, so Python looks for
`abbenay.v1` at `site-packages/abbenay/v1/` — which doesn't exist. The
actual location is `site-packages/abbenay_grpc/abbenay/v1/`.

**Current workaround in APME**

```python
spec = importlib.util.find_spec("abbenay_grpc")
if spec and spec.submodule_search_locations:
    pkg_dir = spec.submodule_search_locations[0]
    if pkg_dir not in sys.path:
        sys.path.insert(0, pkg_dir)
importlib.reload(abbenay_grpc.client)
```

This pollutes `sys.path` and can cause import conflicts.

**Recommended fix**

Change the protoc invocation to generate imports relative to `site-packages/`
by adjusting the proto path or output directory so stubs import from
`abbenay_grpc.abbenay.v1` instead of `abbenay.v1`. Two approaches:

**Option A**: Use `--proto_path` set one level higher and adjust the output:

```bash
python -m grpc_tools.protoc \
    -I "$ROOT_DIR/packages/python/src" \
    --python_out="$ROOT_DIR/packages/python/src" \
    --pyi_out="$ROOT_DIR/packages/python/src" \
    --grpc_python_out="$ROOT_DIR/packages/python/src" \
    "$PROTO_DIR/abbenay/v1/service.proto"
```

This would require restructuring the proto source to mirror the Python
package layout, or post-processing the generated imports.

**Option B**: Post-process generated files to rewrite imports:

```bash
sed -i 's/from abbenay\./from abbenay_grpc.abbenay./g' \
    "$PYTHON_OUT/abbenay/v1/service_pb2_grpc.py"
```

**Option C**: Use `grpc_tools.protoc` with a custom plugin or
`grpcio-tools`' `--grpc_python_out` option that supports
`grpc_package_prefix` (if available in newer versions).

---

## Issue 2: gRPC `aio` channel bound to event loop lifecycle

**Problem**

`AbbenayClient` uses `grpc.aio` channels internally. These channels are
bound to the asyncio event loop that was active when `connect()` was called.
If a consumer calls `asyncio.run()` (which creates and closes a loop) for
a preflight check, then later calls `asyncio.run()` again for the main
workload, the channel is dead:

```
RuntimeError: Event loop is closed
```

This is a fundamental property of `grpc.aio`, but the client API doesn't
surface it. Consumers must manually recreate the client + reconnect when
crossing event loop boundaries.

**Current workaround in APME**

```python
class AbbenayProvider:
    async def reconnect(self) -> None:
        self._client = AbbenayClient(socket_path=...)
        await self._client.connect()
```

**Recommended fix**

Add a `reconnect()` or `reset()` method to `AbbenayClient` that discards
the old channel and creates a fresh one. Alternatively, support lazy
connection (connect on first RPC call) so the channel is always created in
the caller's event loop. Example:

```python
class AbbenayClient:
    async def reconnect(self) -> None:
        """Discard existing channel and reconnect."""
        if self._channel:
            await self._channel.close()
        self._channel = grpc.aio.insecure_channel(self._target)
        self._stub = grpc_service.AbbenayServiceStub(self._channel)
```

Or make `connect()` idempotent — if the channel is dead, recreate it.

---

## Issue 3: `client.py` try/except swallows ImportError silently

**Problem**

```python
try:
    from .abbenay.v1 import service_pb2 as proto
    from .abbenay.v1 import service_pb2_grpc as grpc_service
except ImportError:
    proto = None
    grpc_service = None
```

When stubs fail to import (due to Issue 1), `proto` is silently set to
`None`. The error only surfaces later as `AbbenayError: gRPC stubs not
generated` during `connect()`, which is misleading — the stubs *are*
generated, the import path is just wrong.

**Recommended fix**

Either:
- Raise immediately on ImportError with a clear message about the actual
  cause (import path mismatch, not missing stubs).
- Or log a warning at import time so the root cause is visible:

```python
except ImportError as e:
    import warnings
    warnings.warn(
        f"Failed to import gRPC stubs: {e}. "
        f"This usually means the protobuf imports use the wrong package prefix. "
        f"See: https://github.com/abbenay/abbenay/issues/XXX"
    )
    proto = None
    grpc_service = None
```

---

## Issue 4: Package name vs import name mismatch

**Problem**

The package is published as `abbenay-client` (pip name) but the import
is `abbenay_grpc`. This is a minor ergonomic issue but can confuse
consumers:

```
pip install abbenay-client    # installs the package
import abbenay_grpc           # but this is the import name
```

**Recommendation**

Either align them (e.g., both `abbenay-grpc`) or document the mapping
prominently in the README.

---

## Impact on APME

These issues required ~100 lines of workaround code in APME's
`abbenay_provider.py` (dynamic `sys.path` manipulation, `importlib.reload`,
manual client recreation). Fixing Issue 1 alone would eliminate most of
this complexity.

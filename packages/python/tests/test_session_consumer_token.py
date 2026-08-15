"""Unit tests for AbbenayClient consumer-token forwarding on session RPCs."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from abbenay_grpc.client import AbbenayClient, InsecureTokenError


def _session_proto(session_id: str = "sess-1", model: str = "mock/echo"):
    return SimpleNamespace(
        id=session_id,
        model=model,
        topic="t",
        messages=[],
        created_by=None,
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    )


async def _empty_stream(*_args, **_kwargs):
    if False:  # pragma: no cover
        yield None


def _connected_client(**kwargs) -> AbbenayClient:
    c = AbbenayClient(**kwargs)
    stub = MagicMock()
    stub.CreateSession = AsyncMock(return_value=_session_proto())
    stub.GetSession = AsyncMock(return_value=_session_proto())
    stub.ListSessions = AsyncMock(return_value=SimpleNamespace(sessions=[]))
    stub.DeleteSession = AsyncMock(return_value=SimpleNamespace())
    stub.SessionChat = MagicMock(side_effect=_empty_stream)
    stub.RegisterMcpServer = AsyncMock(
        return_value=SimpleNamespace(discovered_tools=["tool.a"]),
    )
    stub.UnregisterMcpServer = AsyncMock(
        return_value=SimpleNamespace(success=True),
    )
    c._stub = stub
    c._client_id = "test-client"
    return c


@pytest.fixture
def unix_client() -> AbbenayClient:
    return _connected_client(socket_path="/tmp/abbenay-test.sock")


@pytest.fixture
def tls_client() -> AbbenayClient:
    return _connected_client(host="127.0.0.1", port=50051, tls=True)


@pytest.fixture
def insecure_tcp_client() -> AbbenayClient:
    return _connected_client(host="127.0.0.1", port=50051, tls=False)


@pytest.mark.asyncio
async def test_session_crud_forwards_consumer_token(unix_client: AbbenayClient):
    token = "consumer-tok"
    expected = [("x-abbenay-token", token)]

    await unix_client.create_session("mock/echo", topic="owned", token=token)
    unix_client._stub.CreateSession.assert_awaited()
    assert unix_client._stub.CreateSession.await_args.kwargs["metadata"] == expected

    await unix_client.get_session("sess-1", token=token)
    assert unix_client._stub.GetSession.await_args.kwargs["metadata"] == expected

    await unix_client.list_sessions(token=token)
    assert unix_client._stub.ListSessions.await_args.kwargs["metadata"] == expected

    await unix_client.delete_session("sess-1", token=token)
    assert unix_client._stub.DeleteSession.await_args.kwargs["metadata"] == expected


@pytest.mark.asyncio
async def test_create_session_then_session_chat_share_token(unix_client: AbbenayClient):
    token = "shared-consumer-tok"
    expected = [("x-abbenay-token", token)]

    session = await unix_client.create_session("mock/echo", token=token)
    assert session.id == "sess-1"
    assert unix_client._stub.CreateSession.await_args.kwargs["metadata"] == expected

    chunks = [
        chunk
        async for chunk in unix_client.session_chat(session.id, "hi", token=token)
    ]
    assert chunks == []
    assert unix_client._stub.SessionChat.call_args.kwargs["metadata"] == expected


@pytest.mark.asyncio
async def test_tls_tcp_allows_consumer_token(tls_client: AbbenayClient):
    token = "tls-tok"
    await tls_client.create_session("mock/echo", token=token)
    assert tls_client._stub.CreateSession.await_args.kwargs["metadata"] == [
        ("x-abbenay-token", token),
    ]


@pytest.mark.asyncio
async def test_plaintext_tcp_rejects_consumer_token(insecure_tcp_client: AbbenayClient):
    with pytest.raises(InsecureTokenError, match="protected channel"):
        await insecure_tcp_client.create_session("mock/echo", token="leak-me")
    insecure_tcp_client._stub.CreateSession.assert_not_awaited()

    with pytest.raises(InsecureTokenError):
        await insecure_tcp_client.get_session("sess-1", token="leak-me")
    with pytest.raises(InsecureTokenError):
        await insecure_tcp_client.list_sessions(token="leak-me")
    with pytest.raises(InsecureTokenError):
        await insecure_tcp_client.delete_session("sess-1", token="leak-me")
    with pytest.raises(InsecureTokenError):
        async for _ in insecure_tcp_client.session_chat("sess-1", "hi", token="leak-me"):
            pass
    with pytest.raises(InsecureTokenError):
        await insecure_tcp_client.register_mcp_server(
            "s",
            {"type": "http", "url": "http://127.0.0.1:9"},
            token="leak-me",
        )
    with pytest.raises(InsecureTokenError):
        await insecure_tcp_client.unregister_mcp_server("s", token="leak-me")


@pytest.mark.asyncio
async def test_session_crud_omits_metadata_without_token(insecure_tcp_client: AbbenayClient):
    # No token on plaintext TCP remains allowed (local DX / probes).
    await insecure_tcp_client.create_session("mock/echo")
    assert insecure_tcp_client._stub.CreateSession.await_args.kwargs["metadata"] is None

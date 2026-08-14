"""Unit tests for AbbenayClient consumer-token forwarding on session RPCs."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from abbenay_grpc.client import AbbenayClient


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


@pytest.fixture
def client() -> AbbenayClient:
    c = AbbenayClient(host="127.0.0.1", port=50051)
    stub = MagicMock()
    stub.CreateSession = AsyncMock(return_value=_session_proto())
    stub.GetSession = AsyncMock(return_value=_session_proto())
    stub.ListSessions = AsyncMock(return_value=SimpleNamespace(sessions=[]))
    stub.DeleteSession = AsyncMock(return_value=SimpleNamespace())
    stub.SessionChat = MagicMock(side_effect=_empty_stream)
    c._stub = stub
    c._client_id = "test-client"
    return c


@pytest.mark.asyncio
async def test_session_crud_forwards_consumer_token(client: AbbenayClient):
    token = "consumer-tok"
    expected = [("x-abbenay-token", token)]

    await client.create_session("mock/echo", topic="owned", token=token)
    client._stub.CreateSession.assert_awaited()
    assert client._stub.CreateSession.await_args.kwargs["metadata"] == expected

    await client.get_session("sess-1", token=token)
    assert client._stub.GetSession.await_args.kwargs["metadata"] == expected

    await client.list_sessions(token=token)
    assert client._stub.ListSessions.await_args.kwargs["metadata"] == expected

    await client.delete_session("sess-1", token=token)
    assert client._stub.DeleteSession.await_args.kwargs["metadata"] == expected


@pytest.mark.asyncio
async def test_create_session_then_session_chat_share_token(client: AbbenayClient):
    token = "shared-consumer-tok"
    expected = [("x-abbenay-token", token)]

    session = await client.create_session("mock/echo", token=token)
    assert session.id == "sess-1"
    assert client._stub.CreateSession.await_args.kwargs["metadata"] == expected

    chunks = [
        chunk
        async for chunk in client.session_chat(session.id, "hi", token=token)
    ]
    assert chunks == []
    assert client._stub.SessionChat.call_args.kwargs["metadata"] == expected


@pytest.mark.asyncio
async def test_session_crud_omits_metadata_without_token(client: AbbenayClient):
    await client.create_session("mock/echo")
    assert client._stub.CreateSession.await_args.kwargs["metadata"] is None

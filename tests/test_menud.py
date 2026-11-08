"""Tests for wlanpi_webui.menud helper."""

import json
import socket
import threading

import pytest

from wlanpi_webui.menud import revoke_menu_session


def _read_ws_frame(conn):
    """Read and unmask a client WebSocket text frame."""
    head = conn.recv(2)
    if len(head) < 2:
        return None
    b1, b2 = head[0], head[1]
    is_masked = bool(b2 & 0x80)
    payload_len = b2 & 0x7F
    if payload_len == 126:
        payload_len = int.from_bytes(conn.recv(2), "big")
    elif payload_len == 127:
        payload_len = int.from_bytes(conn.recv(8), "big")
    mask = conn.recv(4) if is_masked else b""
    payload = b""
    while len(payload) < payload_len:
        chunk = conn.recv(payload_len - len(payload))
        if not chunk:
            break
        payload += chunk
    if is_masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return json.loads(payload.decode("utf-8"))


def test_revoke_empty_sid():
    assert revoke_menu_session("") is False


def test_revoke_menud_down(tmp_path):
    sock_path = str(tmp_path / "missing.sock")
    assert revoke_menu_session("test-sid", sock_path=sock_path) is False


def test_revoke_successful(tmp_path):
    sock_path = str(tmp_path / "menud.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    srv.listen(1)

    received_frames = []

    def handle_server():
        conn, _ = srv.accept()
        # Read HTTP request
        req = b""
        while b"\r\n\r\n" not in req:
            req += conn.recv(1024)
        # Send 101 response
        conn.sendall(
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\n"
            b"Connection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
        )
        f1 = _read_ws_frame(conn)
        f2 = _read_ws_frame(conn)
        received_frames.extend([f1, f2])
        conn.close()

    t = threading.Thread(target=handle_server)
    t.start()

    res = revoke_menu_session("sess_abc123", sock_path=sock_path, timeout=2.0)
    t.join()
    srv.close()

    assert res is True
    assert len(received_frames) == 2
    assert received_frames[0]["type"] == "hello"
    assert received_frames[1]["type"] == "revoke"
    assert received_frames[1]["webui_session"] == "sess_abc123"


def test_revoke_handshake_rejection(tmp_path):
    sock_path = str(tmp_path / "menud.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    srv.listen(1)

    def handle_server():
        conn, _ = srv.accept()
        conn.recv(1024)
        conn.sendall(b"HTTP/1.1 500 Internal Error\r\n\r\n")
        conn.close()

    t = threading.Thread(target=handle_server)
    t.start()

    res = revoke_menu_session("sess_abc123", sock_path=sock_path, timeout=2.0)
    t.join()
    srv.close()

    assert res is False

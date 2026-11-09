"""Helper for interacting with wlanpi-menud over local.sock."""

from __future__ import annotations

import json
import logging
import socket
import struct
from typing import Any

log = logging.getLogger(__name__)

MENUD_LOCAL_SOCK = "/run/wlanpi-menud/local.sock"


def _make_ws_frame(payload: bytes) -> bytes:
    """Encode a masked WebSocket text frame (RFC 6455)."""
    mask = b"\x13\x37\x42\x24"
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    length = len(payload)
    if length < 126:
        header = bytes([0x81, 0x80 | length]) + mask
    elif length < 65536:
        header = struct.pack("!BBH", 0x81, 0x80 | 126, length) + mask
    else:
        header = struct.pack("!BBQ", 0x81, 0x80 | 127, length) + mask
    return header + masked


def _recv_exact(sock: socket.socket, length: int) -> bytes:
    buf = b""
    while len(buf) < length:
        chunk = sock.recv(length - len(buf))
        if not chunk:
            raise EOFError("socket closed")
        buf += chunk
    return buf


def _recv_ws_frame(sock: socket.socket) -> dict[str, Any] | None:
    """Read one WebSocket frame from server (RFC 6455)."""
    try:
        head = sock.recv(2)
    except (TimeoutError, socket.timeout):
        raise
    except Exception:
        return None
    if not head or len(head) < 2:
        return None
    b1, b2 = head[0], head[1]
    is_masked = bool(b2 & 0x80)
    payload_len = b2 & 0x7F
    opcode = b1 & 0x0F
    if opcode == 0x8:  # connection close frame
        return None
    try:
        if payload_len == 126:
            payload_len = struct.unpack("!H", _recv_exact(sock, 2))[0]
        elif payload_len == 127:
            payload_len = struct.unpack("!Q", _recv_exact(sock, 8))[0]

        if is_masked:
            mask = _recv_exact(sock, 4)
            raw = _recv_exact(sock, payload_len)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(raw))
        else:
            payload = _recv_exact(sock, payload_len)

        return json.loads(payload.decode("utf-8"))
    except (EOFError, ValueError):
        return None


def revoke_menu_session(sid: str, sock_path: str = MENUD_LOCAL_SOCK, timeout: float = 1.0) -> bool:
    """Best-effort notify wlanpi-menud over local.sock to revoke a WebUI session.

    Never raises; returns True if the revoke succeeded, False on error or timeout.
    """
    if not sid:
        return False
    sock = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(sock_path)

        # 1. Opening WebSocket handshake
        req = (
            b"GET /ui/ws HTTP/1.1\r\n"
            b"Host: localhost\r\n"
            b"Upgrade: websocket\r\n"
            b"Connection: Upgrade\r\n"
            b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            b"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(req)

        # Read until end of HTTP headers
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = sock.recv(1024)
            if not chunk:
                break
            resp += chunk

        if b" 101 " not in resp:
            log.warning("menud revoke handshake failed: %r", resp[:128])
            return False

        # 2. Pipeline hello and revoke frames
        hello = json.dumps({"v": 1, "type": "hello", "id": "h:logout", "mode": "rich", "protocol": [1]}).encode()
        revoke = json.dumps({"v": 1, "type": "revoke", "id": "r:logout", "webui_session": sid}).encode()
        sock.sendall(_make_ws_frame(hello) + _make_ws_frame(revoke))

        # 3. Read reply: check for server error frame (e.g. FORBIDDEN or BAD_REQUEST)
        error_seen = None
        sock.settimeout(min(0.2, timeout))
        try:
            while True:
                f = _recv_ws_frame(sock)
                if not f:
                    break
                if f.get("type") == "error":
                    error_seen = f
                    break
        except (TimeoutError, socket.timeout):
            # No error frame sent by menud within window: revoke accepted
            pass

        if error_seen:
            log.warning(
                "menud rejected session revocation for %s: %s (%s)",
                sid,
                error_seen.get("code"),
                error_seen.get("message"),
            )
            return False

        return True
    except (TimeoutError, socket.timeout) as exc:
        log.warning("menud session revocation timed out for %s: %s", sid, exc)
        return False
    except Exception as exc:
        log.warning("notify menud logout failed: %s", exc)
        return False
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass

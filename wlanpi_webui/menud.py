"""Helper for interacting with wlanpi-menud over local.sock."""

from __future__ import annotations

import json
import logging
import socket
import struct

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


def revoke_menu_session(sid: str, sock_path: str = MENUD_LOCAL_SOCK, timeout: float = 1.0) -> bool:
    """Best-effort notify wlanpi-menud over local.sock to revoke a WebUI session.

    Never raises; returns True if the revoke frame was successfully sent, False otherwise.
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
            log.debug("menud handshake failed: %r", resp[:128])
            return False

        # 2. Send hello frame
        hello = json.dumps({"v": 1, "type": "hello", "id": "h:logout", "mode": "rich", "protocol": [1]}).encode()
        sock.sendall(_make_ws_frame(hello))

        # 3. Send revoke frame
        revoke = json.dumps({"v": 1, "type": "revoke", "id": "r:logout", "webui_session": sid}).encode()
        sock.sendall(_make_ws_frame(revoke))
        return True
    except Exception as exc:
        log.debug("notify menud logout failed (best-effort): %s", exc)
        return False
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass

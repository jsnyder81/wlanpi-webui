"""Tests for the Menu panel blueprint."""

import re
import pytest

from wlanpi_webui.app import create_app


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "wlanpi_webui.config.Config.SESSION_KEY_PATH", str(tmp_path / "session_key")
    )
    return create_app()


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, monkeypatch):
    from wlanpi_webui.auth import auth

    monkeypatch.setattr(
        auth, "make_api_request", lambda *a, **k: FakeResponse({"status": "success"})
    )
    page = client.get("/login")
    csrf = re.search(rb'name="csrf_token" value="([^"]+)"', page.data).group(1).decode()
    resp = client.post(
        "/login",
        data={"username": "wlanpi", "password": "x", "csrf_token": csrf},
    )
    assert resp.status_code == 302


class TestMenuBlueprint:
    def test_requires_login(self, client):
        resp = client.get("/menu")
        assert resp.status_code == 302
        assert "/login" in resp.headers["Location"]

    def test_renders_full_page(self, client, monkeypatch):
        _login(client, monkeypatch)
        resp = client.get("/menu")
        assert resp.status_code == 200
        assert b'<html' in resp.data
        assert b'id="menu-panel"' in resp.data
        assert b'Mirror panel' in resp.data
        assert b'id="rich-mode-container"' in resp.data
        assert b'id="mirror-mode-container"' in resp.data
        assert b'data-dpad-key="center"' in resp.data
        assert b'view_blocks.js' in resp.data
        assert b'menu.js' in resp.data

    def test_renders_htmx_partial(self, client, monkeypatch):
        _login(client, monkeypatch)
        resp = client.get("/menu", headers={"HX-Request": "true"})
        assert resp.status_code == 200
        # Should not include full <html> envelope in htmx swap
        assert b'<html' not in resp.data
        assert b'id="menu-panel"' in resp.data
        assert b'id="rich-mode-container"' in resp.data
        assert b'id="mirror-mode-container"' in resp.data

    def test_cockpit_deprecation(self, client, monkeypatch):
        _login(client, monkeypatch)
        with pytest.deprecated_call():
            resp = client.get("/cockpit")
            assert resp.status_code == 302

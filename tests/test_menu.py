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
        assert b'data-panel="menu"' in resp.data
        # One surface: the shell's mount points, and no protocol mode control.
        for mount in (b'id="menu-statusbar"', b'id="menu-sidebar"', b'id="menu-page"',
                      b'id="menu-front-panel"', b'id="menu-dialog"', b'id="menu-live"',
                      b'id="menu-banner"'):
            assert mount in resp.data
        assert b'menu-mode-select' not in resp.data
        assert b'Thin' not in resp.data
        assert b'Mirror' not in resp.data
        assert b'css/menu.css' in resp.data
        assert b'view_blocks.js' in resp.data
        for script in (b'connection', b'store', b'router', b'pages', b'prompt_dialog',
                       b'activity', b'front_panel', b'main'):
            assert b'js/menu/' + script + b'.js' in resp.data
        assert b'js/menu.js' not in resp.data

    def test_scripts_load_in_dependency_order(self, client, monkeypatch):
        _login(client, monkeypatch)
        html = client.get("/menu").data
        order = [html.index(b'js/' + name) for name in (
            b'view_blocks.js', b'menu/connection.js', b'menu/store.js', b'menu/router.js',
            b'menu/pages.js', b'menu/prompt_dialog.js', b'menu/activity.js',
            b'menu/front_panel.js', b'menu/main.js')]
        assert order == sorted(order)

    def test_renders_htmx_partial(self, client, monkeypatch):
        _login(client, monkeypatch)
        resp = client.get("/menu", headers={"HX-Request": "true"})
        assert resp.status_code == 200
        # Should not include full <html> envelope in htmx swap
        assert b'<html' not in resp.data
        assert b'id="menu-panel"' in resp.data
        assert b'id="menu-page"' in resp.data
        assert b'id="menu-front-panel"' in resp.data
        # The shell carries no inline styles and no menu content of its own.
        assert b'style=' not in resp.data

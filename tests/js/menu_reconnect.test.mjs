import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const menuCode = fs.readFileSync(
  path.resolve(__dirname, "../../wlanpi_webui/static/js/menu.js"),
  "utf8"
);

function createTestHarness() {
  class MockElement {
    constructor(id) {
      this.id = id;
      this.dataset = {};
      this.style = {};
      this.innerHTML = "";
      this.textContent = "";
      this.className = "";
    }
    addEventListener() {}
    removeEventListener() {}
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
  }

  const elements = {
    "menu-panel": new MockElement("menu-panel"),
    "toggle-mirror-mode": new MockElement("toggle-mirror-mode"),
    "rich-mode-container": new MockElement("rich-mode-container"),
    "mirror-mode-container": new MockElement("mirror-mode-container"),
    "menu-connection-status": new MockElement("menu-connection-status"),
    "rich-menu-items": new MockElement("rich-menu-items"),
    "mirror-screen-blocks": new MockElement("mirror-screen-blocks"),
  };

  const instances = [];
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      instances.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    open() {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) this.onopen();
    }
    close(code, reason) {
      this.readyState = MockWebSocket.CLOSED;
      if (this.onclose) this.onclose({ code: code || 1000, reason: reason || "" });
    }
    receiveFrame(frame) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) });
    }
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;

  const windowListeners = {};
  const documentListeners = {};
  let timerSeq = 0;
  const timers = new Map();
  const toasts = [];

  const ctx = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    setTimeout: (fn, ms) => {
      const id = ++timerSeq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    WebSocket: MockWebSocket,
    window: {
      location: { protocol: "http:", host: "localhost" },
      addEventListener: (evt, fn) => {
        windowListeners[evt] = fn;
      },
      UIkit: {
        notification: (opts) => {
          toasts.push(opts);
        },
      },
      ViewBlocks: {
        escapeHtml: (s) => s,
      },
    },
    document: {
      getElementById: (id) => elements[id] || new MockElement(id),
      addEventListener: (evt, fn) => {
        documentListeners[evt] = fn;
      },
    },
  };

  vm.createContext(ctx);
  vm.runInContext(menuCode, ctx);

  // Initialize client
  windowListeners.load();

  function fireTimer() {
    const entries = Array.from(timers.entries());
    if (entries.length === 0) return false;
    const [id, t] = entries[0];
    timers.delete(id);
    t.fn();
    return true;
  }

  return {
    elements,
    instances,
    timers,
    toasts,
    fireTimer,
  };
}

describe("Menu WebSocket Reconnect and Stop Logic", () => {
  it("stops reconnect retries on 1008 policy violation and displays origin mismatch fallback", () => {
    const h = createTestHarness();
    assert.equal(h.instances.length, 1);
    const ws = h.instances[0];
    ws.open();
    assert.equal(h.elements["menu-connection-status"].textContent, "Connected (rich)");

    // Server closes with 1008 (policy violation / origin mismatch)
    ws.close(1008, "origin mismatch");

    assert.equal(h.elements["menu-connection-status"].textContent, "Forbidden");
    assert.match(
      h.elements["rich-menu-items"].innerHTML,
      /Menu unavailable \(policy violation \/ origin mismatch\)\./
    );
    assert.match(
      h.elements["mirror-screen-blocks"].innerHTML,
      /Menu unavailable \(policy violation \/ origin mismatch\)\./
    );
    // Reconnect timer must NOT be scheduled
    assert.equal(h.timers.size, 0, "no reconnect timer scheduled on 1008");
  });

  it("stops reconnect retries on two consecutive 1006 abnormal closes and displays fallback", () => {
    const h = createTestHarness();
    assert.equal(h.instances.length, 1);
    const ws1 = h.instances[0];
    ws1.open();

    // First abnormal close (1006)
    ws1.close(1006, "abnormal 1");
    assert.equal(h.elements["menu-connection-status"].textContent, "Disconnected");
    assert.equal(h.timers.size, 1, "reconnect timer scheduled after first abnormal close");

    // Execute scheduled reconnect timer
    const fired = h.fireTimer();
    assert.ok(fired);
    assert.equal(h.instances.length, 2, "second WebSocket connection created on reconnect");

    // Second consecutive abnormal close (1006) without receiving any frame
    const ws2 = h.instances[1];
    ws2.open();
    ws2.close(1006, "abnormal 2");

    assert.equal(h.elements["menu-connection-status"].textContent, "Unavailable");
    assert.match(h.elements["rich-menu-items"].innerHTML, /Menu unavailable\./);
    assert.match(h.elements["mirror-screen-blocks"].innerHTML, /Menu unavailable\./);
    assert.equal(h.timers.size, 0, "no reconnect timer scheduled after 2 consecutive 1006 closes");
  });

  it("resets consecutive 1006 counter when a frame is received between abnormal closes", () => {
    const h = createTestHarness();
    assert.equal(h.instances.length, 1);
    const ws1 = h.instances[0];
    ws1.open();

    // First abnormal close
    ws1.close(1006, "abnormal 1");
    assert.equal(h.timers.size, 1);
    h.fireTimer();

    assert.equal(h.instances.length, 2);
    const ws2 = h.instances[1];
    ws2.open();

    // Receive a valid frame -> resets consecutiveAbnormalCloses counter to 0
    ws2.receiveFrame({
      v: 1,
      type: "welcome",
      id: "h:welcome",
      roles: ["admin"],
      session: "new",
    });

    // Now close abnormally again: this is the 1st consecutive close since the frame
    ws2.close(1006, "abnormal 2");

    assert.equal(h.elements["menu-connection-status"].textContent, "Disconnected");
    assert.equal(h.timers.size, 1, "reconnect timer scheduled because counter was reset");

    // Fire timer again to show retry continues
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 3, "third WebSocket connection attempted");
  });

  it("stops reconnect retries on 4401 session revocation without showing menu-unavailable fallback", () => {
    const h = createTestHarness();
    assert.equal(h.instances.length, 1);
    const ws = h.instances[0];
    ws.open();

    // Server closes with 4401 (session revoked)
    ws.close(4401, "WebUI session ended");

    assert.equal(h.elements["menu-connection-status"].textContent, "Session Revoked");
    assert.equal(h.timers.size, 0, "no reconnect timer scheduled on 4401");
    // 4401 should display toast but not overwrite menu containers with "Menu unavailable"
    assert.equal(h.elements["rich-menu-items"].innerHTML, "");
    assert.ok(
      h.toasts.some((t) => t.message.includes("Authentication expired or session revoked"))
    );
  });
});

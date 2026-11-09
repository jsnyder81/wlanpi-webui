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
      this.listeners = {};
    }
    addEventListener(evt, fn) {
      this.listeners[evt] = this.listeners[evt] || [];
      this.listeners[evt].push(fn);
    }
    removeEventListener(evt, fn) {
      if (this.listeners[evt]) {
        this.listeners[evt] = this.listeners[evt].filter((f) => f !== fn);
      }
    }
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    dispatchEvent(event) {
      const fns = this.listeners[event.type] || [];
      for (const fn of fns) fn(event);
    }
    closest(sel) {
      if (sel === ".menu-retry-btn" && this.className.includes("menu-retry-btn")) return this;
      if (sel === "#menu-retry-btn" && this.id === "menu-retry-btn") return this;
      return null;
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

  function clickRetry() {
    const btn = new MockElement("retry-btn");
    btn.className = "menu-retry-btn";
    const panel = elements["menu-panel"];
    panel.dispatchEvent({
      type: "click",
      target: btn,
      preventDefault: () => {},
    });
  }

  function getScheduledDelay() {
    const entries = Array.from(timers.entries());
    if (entries.length === 0) return null;
    return entries[0][1].ms;
  }

  return {
    elements,
    instances,
    timers,
    toasts,
    fireTimer,
    clickRetry,
    getScheduledDelay,
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
    // 1008 must not include retry control
    assert.doesNotMatch(h.elements["rich-menu-items"].innerHTML, /menu-retry-btn/);
    // Reconnect timer must NOT be scheduled
    assert.equal(h.timers.size, 0, "no reconnect timer scheduled on 1008");
  });

  it("backs off exponentially on consecutive 1006 abnormal closes, displays fallback with retry, and caps at 60s", () => {
    const h = createTestHarness();
    assert.equal(h.instances.length, 1);
    const ws1 = h.instances[0];
    ws1.open();

    // 1st abnormal close (1006) -> initial backoff 2000ms
    ws1.close(1006, "abnormal 1");
    assert.equal(h.elements["menu-connection-status"].textContent, "Disconnected");
    assert.equal(h.timers.size, 1);
    assert.equal(h.getScheduledDelay(), 2000, "1st reconnect delay is 2s");

    // Execute 1st scheduled reconnect
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 2);

    // 2nd consecutive abnormal close (1006) -> backoff 4000ms, shows Unavailable + Retry button
    const ws2 = h.instances[1];
    ws2.open();
    ws2.close(1006, "abnormal 2");

    assert.equal(h.elements["menu-connection-status"].textContent, "Unavailable");
    assert.match(h.elements["rich-menu-items"].innerHTML, /Menu unavailable\./);
    assert.match(h.elements["rich-menu-items"].innerHTML, /menu-retry-btn/);
    assert.match(h.elements["mirror-screen-blocks"].innerHTML, /menu-retry-btn/);
    assert.equal(h.timers.size, 1, "reconnect timer is still scheduled (no hard stop)");
    assert.equal(h.getScheduledDelay(), 4000, "2nd reconnect delay is 4s");

    // 3rd close -> 8000ms
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 3);
    const ws3 = h.instances[2];
    ws3.open();
    ws3.close(1006, "abnormal 3");
    assert.equal(h.getScheduledDelay(), 8000, "3rd reconnect delay is 8s");

    // 4th close -> 16000ms
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 4);
    const ws4 = h.instances[3];
    ws4.open();
    ws4.close(1006, "abnormal 4");
    assert.equal(h.getScheduledDelay(), 16000, "4th reconnect delay is 16s");

    // 5th close -> 32000ms
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 5);
    const ws5 = h.instances[4];
    ws5.open();
    ws5.close(1006, "abnormal 5");
    assert.equal(h.getScheduledDelay(), 32000, "5th reconnect delay is 32s");

    // 6th close -> 60000ms (capped at 60s)
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 6);
    const ws6 = h.instances[5];
    ws6.open();
    ws6.close(1006, "abnormal 6");
    assert.equal(h.getScheduledDelay(), 60000, "6th reconnect delay is 60s cap");

    // 7th close -> stays capped at 60000ms
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 7);
    const ws7 = h.instances[6];
    ws7.open();
    ws7.close(1006, "abnormal 7");
    assert.equal(h.getScheduledDelay(), 60000, "7th reconnect delay remains capped at 60s");
  });

  it("immediately reconnects and resets backoff when Retry is clicked", () => {
    const h = createTestHarness();
    assert.equal(h.instances.length, 1);
    const ws1 = h.instances[0];
    ws1.open();
    ws1.close(1006, "abnormal 1");
    h.fireTimer();

    const ws2 = h.instances[1];
    ws2.open();
    ws2.close(1006, "abnormal 2");
    assert.equal(h.elements["menu-connection-status"].textContent, "Unavailable");
    assert.equal(h.timers.size, 1);
    assert.equal(h.getScheduledDelay(), 4000);

    // User clicks the Retry button
    h.clickRetry();

    assert.equal(h.elements["menu-connection-status"].textContent, "Connecting...");
    assert.equal(h.instances.length, 3, "new connection created immediately without waiting for timer");
    assert.equal(h.timers.size, 0, "previous backoff timer was cleared");

    // If this new connection also closes abnormally, backoff starts from 2000ms
    const ws3 = h.instances[2];
    ws3.close(1006, "abnormal after retry");
    assert.equal(h.getScheduledDelay(), 2000, "backoff delay was reset to 2s");
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

  it("resets consecutive 1006 counter on a non-1006 close path (1006, then 1000, then 1006 still reconnects)", () => {
    const h = createTestHarness();
    assert.equal(h.instances.length, 1);
    const ws1 = h.instances[0];
    ws1.open();

    // First abnormal close (1006)
    ws1.close(1006, "abnormal 1");
    assert.equal(h.elements["menu-connection-status"].textContent, "Disconnected");
    assert.equal(h.timers.size, 1);

    // Reconnect fires -> ws2 connects and sends hello on open
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 2);
    const ws2 = h.instances[1];
    ws2.open();
    assert.equal(ws2.sent.length, 1, "hello sent on open");

    // ws2 closes cleanly on a non-1006 path (code 1000 normal close)
    // Pins menu.js:116: consecutiveAbnormalCloses must reset on non-1006 close
    ws2.close(1000, "normal closure");
    assert.equal(h.elements["menu-connection-status"].textContent, "Disconnected");
    assert.equal(h.timers.size, 1, "reconnect timer scheduled after non-1006 close");

    // Reconnect fires -> ws3 connects
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 3);
    const ws3 = h.instances[2];
    ws3.open();

    // Another 1006 abnormal close: must NOT stop reconnecting at 2 total because counter was reset
    ws3.close(1006, "abnormal 2");
    assert.equal(h.elements["menu-connection-status"].textContent, "Disconnected");
    assert.notEqual(h.elements["menu-connection-status"].textContent, "Unavailable");
    assert.equal(h.timers.size, 1, "reconnect timer scheduled because counter was reset by non-1006 close");

    // Next reconnect succeeds in scheduling ws4
    assert.ok(h.fireTimer());
    assert.equal(h.instances.length, 4, "reconnect loop continues");
  });

  it("resets consecutive 1006 counter after successful frame exchange and non-1006 close", () => {
    const h = createTestHarness();
    assert.equal(h.instances.length, 1);
    const ws1 = h.instances[0];
    ws1.open();
    ws1.close(1006, "abnormal 1");
    assert.equal(h.timers.size, 1);
    h.fireTimer();

    assert.equal(h.instances.length, 2);
    const ws2 = h.instances[1];
    ws2.open();
    assert.equal(ws2.sent.length, 1, "hello sent on open");
    ws2.receiveFrame({ v: 1, type: "welcome", id: "h:welcome", roles: ["admin"], session: "new" });
    ws2.close(1000, "clean close after frame exchange");
    assert.equal(h.timers.size, 1);
    h.fireTimer();

    assert.equal(h.instances.length, 3);
    const ws3 = h.instances[2];
    ws3.open();
    ws3.close(1006, "abnormal after exchange");
    assert.equal(h.elements["menu-connection-status"].textContent, "Disconnected");
    assert.notEqual(h.elements["menu-connection-status"].textContent, "Unavailable");
    assert.equal(h.timers.size, 1, "reconnect loop continues after frame exchange and non-1006 close");
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

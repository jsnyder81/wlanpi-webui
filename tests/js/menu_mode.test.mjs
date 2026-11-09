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

function createModeTestHarness() {
  const elements = {};

  class MockElement {
    constructor(id) {
      this._id = id;
      if (id) elements[id] = this;
      this.dataset = {};
      this.style = {};
      this.innerHTML = "";
      this.textContent = "";
      this.className = "";
      this.listeners = {};
      this.value = "";
      this.children = [];
    }
    set id(val) {
      this._id = val;
      if (val) elements[val] = this;
    }
    get id() {
      return this._id;
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
    get firstChild() {
      return this.children[0] || null;
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    insertBefore(newChild, refChild) {
      const idx = this.children.indexOf(refChild);
      if (idx !== -1) {
        this.children.splice(idx, 0, newChild);
      } else {
        this.children.unshift(newChild);
      }
      return newChild;
    }
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      return child;
    }
    scrollIntoView() {}
    dispatchEvent(event) {
      const fns = this.listeners[event.type] || [];
      for (const fn of fns) fn(event);
    }
    closest(sel) {
      if (sel === ".menu-node-card") return this;
      if (sel === "#menu-mode-select") return this;
      return null;
    }
    getAttribute(name) {
      return this[name] || this.dataset[name] || null;
    }
  }

  elements["menu-panel"] = new MockElement("menu-panel");
  elements["menu-mode-select"] = new MockElement("menu-mode-select");
  elements["toggle-mirror-mode"] = new MockElement("toggle-mirror-mode");
  elements["rich-mode-container"] = new MockElement("rich-mode-container");
  elements["mirror-mode-container"] = new MockElement("mirror-mode-container");
  elements["menu-connection-status"] = new MockElement("menu-connection-status");
  elements["menu-session-kind"] = new MockElement("menu-session-kind");
  elements["rich-menu-items"] = new MockElement("rich-menu-items");
  elements["rich-action-detail"] = new MockElement("rich-action-detail");
  elements["rich-job-results"] = new MockElement("rich-job-results");
  elements["mirror-screen-blocks"] = new MockElement("mirror-screen-blocks");

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
        notification: () => {},
      },
      ViewBlocks: {
        escapeHtml: (s) => String(s || ""),
        escapeAttr: (s) => String(s || ""),
        renderBlocks: (b) => `<blocks count="${b.length}"/>`,
        mountQrCodes: () => {},
      },
    },
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => {
        const el = new MockElement(tag);
        return el;
      },
      addEventListener: (evt, fn) => {
        documentListeners[evt] = fn;
      },
    },
  };

  vm.createContext(ctx);
  vm.runInContext(menuCode, ctx);

  windowListeners.load();

  return {
    elements,
    instances,
    latestWs: () => instances[instances.length - 1],
    timers,
  };
}

describe("Menu Panel Three-Way Mode and Rich Invocation", () => {
  it("initializes in rich-private mode and sends hello mode=rich session=new", () => {
    const h = createModeTestHarness();
    const ws = h.latestWs();
    assert.ok(ws, "WebSocket should be created");
    ws.open();

    const hello = JSON.parse(ws.sent[0]);
    assert.equal(hello.type, "hello");
    assert.equal(hello.mode, "rich");
    assert.equal(hello.session, "new");

    ws.receiveFrame({ v: 1, type: "welcome", id: hello.id, mode: "rich", session: "new" });
    assert.equal(h.elements["menu-session-kind"].textContent, "Rich (private)");
  });

  it("switches to thin-private with hello mode=thin session=new cleanly", () => {
    const h = createModeTestHarness();
    const ws1 = h.latestWs();
    ws1.open();

    // Trigger switch to thin-private via select change
    const select = h.elements["menu-mode-select"];
    select.value = "thin-private";
    select.onchange();

    // Previous socket closed with 1000
    assert.equal(ws1.readyState, 3);

    // New socket created
    const ws2 = h.latestWs();
    assert.notEqual(ws1, ws2);
    ws2.open();

    const hello = JSON.parse(ws2.sent[0]);
    assert.equal(hello.mode, "thin");
    assert.equal(hello.session, "new");

    ws2.receiveFrame({ v: 1, type: "welcome", id: hello.id, mode: "thin", session: "new" });
    assert.equal(h.elements["menu-session-kind"].textContent, "Thin (private)");
    assert.equal(h.elements["rich-mode-container"].style.display, "none");
    assert.equal(h.elements["mirror-mode-container"].style.display, "block");
  });

  it("switches to thin-mirror with hello mode=thin session=default cleanly", () => {
    const h = createModeTestHarness();
    const ws1 = h.latestWs();
    ws1.open();

    // Trigger switch to thin-mirror
    const select = h.elements["menu-mode-select"];
    select.value = "thin-mirror";
    select.onchange();

    const ws2 = h.latestWs();
    ws2.open();

    const hello = JSON.parse(ws2.sent[0]);
    assert.equal(hello.mode, "thin");
    assert.equal(hello.session, "default");

    ws2.receiveFrame({ v: 1, type: "welcome", id: hello.id, mode: "thin", session: "default" });
    assert.equal(h.elements["menu-session-kind"].textContent, "Thin (mirror panel)");
    assert.equal(h.elements["rich-mode-container"].style.display, "none");
    assert.equal(h.elements["mirror-mode-container"].style.display, "block");
  });

  it("invokes no-param view action immediately without detail pane", () => {
    const h = createModeTestHarness();
    const ws = h.latestWs();
    ws.open();
    const hello = JSON.parse(ws.sent[0]);
    ws.receiveFrame({ v: 1, type: "welcome", id: hello.id, mode: "rich", session: "new" });

    // Send menu frame with network.interfaces
    ws.receiveFrame({
      v: 1,
      type: "menu",
      id: "s:1",
      nodes: [
        { id: "network", label: "Network", parent: null, order: 10, kind: "branch" },
        { id: "network.interfaces", label: "Interfaces", parent: "network", order: 10, kind: "action", view: "table" },
      ],
    });

    // Simulate clicking network.interfaces card
    const card = new h.elements["menu-panel"].constructor("card");
    card["data-node-id"] = "network.interfaces";
    card["data-is-branch"] = "0";

    h.elements["menu-panel"].dispatchEvent({
      type: "click",
      target: card,
      preventDefault: () => {},
    });

    // An invoke frame must have been sent immediately
    const invokeFrame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "invoke");
    assert.ok(invokeFrame, "Invoke frame should be sent on card click");
    assert.equal(invokeFrame.node, "network.interfaces");

    // Detail pane remains hidden
    assert.equal(h.elements["rich-action-detail"].style.display, "none");
  });

  it("sends nav frame when clicking branch with landing view", () => {
    const h = createModeTestHarness();
    const ws = h.latestWs();
    ws.open();
    const hello = JSON.parse(ws.sent[0]);
    ws.receiveFrame({ v: 1, type: "welcome", id: hello.id, mode: "rich", session: "new" });

    // Send menu frame with a branch that has view: "table"
    ws.receiveFrame({
      v: 1,
      type: "menu",
      id: "s:1",
      nodes: [
        { id: "network", label: "Network", parent: null, order: 10, kind: "branch", view: "table" },
      ],
    });

    // Simulate clicking network branch card
    const card = new h.elements["menu-panel"].constructor("card");
    card["data-node-id"] = "network";
    card["data-is-branch"] = "1";

    h.elements["menu-panel"].dispatchEvent({
      type: "click",
      target: card,
      preventDefault: () => {},
    });

    // A nav frame must have been sent
    const navFrame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "nav");
    assert.ok(navFrame, "Nav frame should be sent for branch with landing view");
    assert.equal(navFrame.node, "network");

    // Receive view frame in rich mode -> rendered into results
    ws.receiveFrame({
      v: 1,
      type: "view",
      id: navFrame.id,
      screen: "menu",
      node: "network",
      title: "Network",
      blocks: [{ type: "table", headers: ["A"], rows: [["1"]] }],
    });

    const results = h.elements["rich-job-results"];
    assert.ok(results.children.length > 0, "View block card should be mounted in results container");
  });

  it("guards against stale ws.onclose from old socket arriving after mode switch", () => {
    const h = createModeTestHarness();
    const ws1 = h.latestWs();
    ws1.open();
    const hello1 = JSON.parse(ws1.sent[0]);
    ws1.receiveFrame({ v: 1, type: "welcome", id: hello1.id, mode: "rich", session: "new" });
    assert.equal(h.elements["menu-connection-status"].textContent, "Active (rich)");

    // Override ws1.close to NOT fire onclose synchronously, simulating real async WebSocket close
    ws1.close = function (code, reason) {
      this.readyState = 3; // CLOSED
      this._pendingClose = { code: code || 1000, reason: reason || "" };
    };

    // Switch mode to thin-private
    const select = h.elements["menu-mode-select"];
    select.value = "thin-private";
    select.onchange();

    const ws2 = h.latestWs();
    assert.notEqual(ws1, ws2);
    ws2.open();
    const hello2 = JSON.parse(ws2.sent[0]);
    ws2.receiveFrame({ v: 1, type: "welcome", id: hello2.id, mode: "thin", session: "new" });
    assert.equal(h.elements["menu-connection-status"].textContent, "Active (thin)");

    const timersBefore = h.timers.size;

    // Simulate stale close event arriving from ws1 after the switch
    assert.ok(ws1._pendingClose);
    ws1.onclose(ws1._pendingClose);

    // Status MUST NOT be overwritten to "Disconnected" or "Unavailable"
    assert.equal(h.elements["menu-connection-status"].textContent, "Active (thin)");
    // No reconnect timer should have been scheduled on ws2
    assert.equal(h.timers.size, timersBefore);

    // Also test abnormal close (1006) from old socket
    ws1.onclose({ code: 1006, reason: "abnormal" });
    assert.equal(h.elements["menu-connection-status"].textContent, "Active (thin)");
    assert.equal(h.timers.size, timersBefore);
  });
});

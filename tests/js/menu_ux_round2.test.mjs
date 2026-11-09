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

function createUxRound2TestHarness() {
  const elements = {};

  class MockHTMLCollection {
    constructor(owner) {
      this._owner = owner;
      return new Proxy(this, {
        get(target, prop) {
          const arr = target._owner._children;
          if (prop === "length") return arr.length;
          if (prop === "item") return (idx) => arr[idx] ?? null;
          if (prop === "namedItem") return (name) => arr.find((el) => el.id === name || (el.getAttribute && el.getAttribute("name") === name)) ?? null;
          if (prop === Symbol.iterator) return arr[Symbol.iterator].bind(arr);
          if (typeof prop === "string" && !isNaN(prop)) {
            const idx = Number(prop);
            return arr[idx];
          }
          // HTMLCollection has no Array prototype methods like indexOf, slice, etc.
          return undefined;
        },
        has(target, prop) {
          const arr = target._owner._children;
          if (prop === "length" || prop === "item" || prop === "namedItem" || prop === Symbol.iterator) return true;
          if (typeof prop === "string" && !isNaN(prop)) return Number(prop) < arr.length;
          return false;
        },
      });
    }
  }

  class MockElement {
    constructor(id) {
      this._id = id;
      if (id) elements[id] = this;
      this.dataset = {};
      this.style = {};
      this._innerHTML = "";
      this.textContent = "";
      this.className = "";
      this.listeners = {};
      this.value = "";
      this.checked = false;
      this.parentElement = null;
      this.parentNode = null;
      this._children = [];
      this.children = new MockHTMLCollection(this);
    }
    set innerHTML(val) {
      this._innerHTML = val;
      if (val === "") {
        for (const c of this._children) {
          c.parentElement = null;
          c.parentNode = null;
        }
        this._children = [];
      }
    }
    get innerHTML() {
      return this._innerHTML ?? "";
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
    querySelector(sel) {
      if (sel === ".rich-prev-body") {
        for (const c of this._children) {
          if (c.className && c.className.includes("rich-prev-body")) return c;
        }
        const b = new MockElement("rich-prev-body");
        b.className = "rich-prev-body";
        this.appendChild(b);
        return b;
      }
      return null;
    }
    querySelectorAll() {
      return [];
    }
    get firstChild() {
      return this._children[0] || null;
    }
    appendChild(child) {
      if (child.parentElement) {
        child.parentElement.removeChild(child);
      }
      this._children.push(child);
      child.parentElement = this;
      child.parentNode = this;
      return child;
    }
    insertBefore(newChild, refChild) {
      if (newChild.parentElement) {
        newChild.parentElement.removeChild(newChild);
      }
      const idx = this._children.indexOf(refChild);
      if (idx !== -1) {
        this._children.splice(idx, 0, newChild);
      } else {
        this._children.unshift(newChild);
      }
      newChild.parentElement = this;
      newChild.parentNode = this;
      return newChild;
    }
    removeChild(child) {
      const idx = this._children.indexOf(child);
      if (idx !== -1) {
        this._children.splice(idx, 1);
      }
      child.parentElement = null;
      child.parentNode = null;
      return child;
    }
    scrollIntoView() {}
    dispatchEvent(event) {
      const fns = this.listeners[event.type] || [];
      for (const fn of fns) fn(event);
      const onHandler = this["on" + event.type];
      if (typeof onHandler === "function") onHandler(event);
    }
    closest(sel) {
      if (sel === ".menu-node-card") return this;
      if (sel === "#menu-mode-select") return this;
      if (sel === "[data-side-dpad-key]") return this["data-side-dpad-key"] ? this : null;
      if (sel === "#close-side-mirror") return this._id === "close-side-mirror" ? this : null;
      return null;
    }
    getAttribute(name) {
      return this[name] || this.dataset[name] || null;
    }
    setAttribute(name, val) {
      this[name] = val;
      this.dataset[name] = val;
    }
  }

  elements["menu-panel"] = new MockElement("menu-panel");
  elements["menu-mode-select"] = new MockElement("menu-mode-select");
  elements["toggle-mirror-mode"] = new MockElement("toggle-mirror-mode");
  elements["toggle-side-mirror"] = new MockElement("toggle-side-mirror");
  elements["close-side-mirror"] = new MockElement("close-side-mirror");
  elements["side-mirror-container"] = new MockElement("side-mirror-container");
  elements["side-mirror-status"] = new MockElement("side-mirror-status");
  elements["side-mirror-title"] = new MockElement("side-mirror-title");
  elements["side-mirror-breadcrumb"] = new MockElement("side-mirror-breadcrumb");
  elements["side-mirror-driven-by"] = new MockElement("side-mirror-driven-by");
  elements["side-mirror-screen-blocks"] = new MockElement("side-mirror-screen-blocks");
  elements["side-mirror-hints"] = new MockElement("side-mirror-hints");
  elements["rich-mode-container"] = new MockElement("rich-mode-container");
  elements["mirror-mode-container"] = new MockElement("mirror-mode-container");
  elements["menu-connection-status"] = new MockElement("menu-connection-status");
  elements["menu-session-kind"] = new MockElement("menu-session-kind");
  elements["rich-device-summary"] = new MockElement("rich-device-summary");
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
        renderKv: (b) => {
          const items = (b && b.items) || [];
          return items.map((it) => `${it.key}: ${it.value}`).join("; ");
        },
        renderStatus: (b) => `[${b.level}] ${b.message}`,
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
    ctx,
  };
}

describe("UX Round 2: Results Bounds, Independent Side Mirror, Device Strip", () => {
  it("Item 9: subscribes to device.summary in rich mode and renders device strip", () => {
    const h = createUxRound2TestHarness();
    const ws = h.latestWs();
    ws.open();

    const hello = JSON.parse(ws.sent[0]);
    ws.receiveFrame({ v: 1, type: "welcome", id: hello.id, mode: "rich", session: "new" });

    // Ensure subscribe frame sent for device.summary
    const subFrame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "subscribe");
    assert.ok(subFrame, "subscribe frame must be sent in rich mode");
    assert.ok(subFrame.topics.includes("device.summary"), "subscribe must include device.summary");

    // Receive device.summary event
    ws.receiveFrame({
      v: 1,
      type: "event",
      id: "ev:1",
      topic: "device.summary",
      seq: 1,
      data: {
        hostname: "wlanpi-r2",
        mode: "classic",
        ip: "10.0.0.1",
        cpu_temp: "42.5C",
      },
    });

    const summaryEl = h.elements["rich-device-summary"];
    assert.ok(summaryEl.innerHTML.includes("wlanpi-r2"), "Device strip should render hostname");
    assert.ok(summaryEl.innerHTML.includes("classic"), "Device strip should render mode");
    assert.ok(summaryEl.innerHTML.includes("10.0.0.1"), "Device strip should render IP");
    assert.ok(summaryEl.innerHTML.includes("42.5C"), "Device strip should render CPU temp");
  });

  it("Item 7: bounds Results & Activity container to at most latest active card + folded previous result", () => {
    const h = createUxRound2TestHarness();
    const ws = h.latestWs();
    ws.open();
    const hello = JSON.parse(ws.sent[0]);
    ws.receiveFrame({ v: 1, type: "welcome", id: hello.id, mode: "rich", session: "new" });

    const results = h.elements["rich-job-results"];

    // Action 1: View
    ws.receiveFrame({
      v: 1,
      type: "view",
      id: "v:1",
      node: "network.interfaces",
      title: "Interfaces",
      blocks: [],
    });
    assert.equal(results.children.length, 1, "After action 1, container has 1 card");
    assert.equal(results.children[0].dataset.resultTitle, "Interfaces");

    // Action 2: Job
    ws.receiveFrame({
      v: 1,
      type: "job",
      id: "j:1",
      job_id: "job-1",
      node: "system.reboot",
      state: "result",
      result: { title: "Reboot", blocks: [] },
    });
    // Now there should be at most 2 elements: active card (job-1) + previous result details
    assert.equal(results.children.length, 2, "After action 2, container has active card + previous result");
    assert.equal(results.children[0].dataset.resultTitle, "Reboot");
    const prevDetails1 = h.elements["rich-previous-result"];
    assert.ok(prevDetails1, "Previous result details element should exist");
    assert.ok(prevDetails1.innerHTML.includes("Interfaces"), "Previous result details mentions Interfaces");

    // Action 3: Another view
    ws.receiveFrame({
      v: 1,
      type: "view",
      id: "v:2",
      node: "network.adapters",
      title: "Adapters",
      blocks: [],
    });
    assert.equal(results.children.length, 2, "After action 3, container remains bounded to 2 elements");
    assert.equal(results.children[0].dataset.resultTitle, "Adapters");
    assert.ok(prevDetails1.innerHTML.includes("Reboot"), "Previous result details now mentions Reboot");

    // Action 4 & 5: successive actions keep container size strictly <= 2
    for (let i = 4; i <= 5; i++) {
      ws.receiveFrame({
        v: 1,
        type: "view",
        id: `v:${i}`,
        node: `node.${i}`,
        title: `Node ${i}`,
        blocks: [],
      });
      assert.ok(results.children.length <= 2, `DOM remains bounded after action ${i}`);
    }
  });

  it("Item m4: re-invoking folded node creates fresh card rather than reusing folded element", () => {
    const h = createUxRound2TestHarness();
    const ws = h.latestWs();
    ws.open();
    const hello = JSON.parse(ws.sent[0]);
    ws.receiveFrame({ v: 1, type: "welcome", id: hello.id, mode: "rich", session: "new" });

    const results = h.elements["rich-job-results"];

    // 1. Invoke action A
    ws.receiveFrame({
      v: 1,
      type: "view",
      id: "v:1",
      node: "network.interfaces",
      title: "Interfaces",
      blocks: [],
    });
    assert.equal(results.children.length, 1);
    const cardA1 = results.children[0];
    assert.equal(cardA1.dataset.resultTitle, "Interfaces");

    // 2. Invoke action B (A is folded into <details>)
    ws.receiveFrame({
      v: 1,
      type: "view",
      id: "v:2",
      node: "system.reboot",
      title: "Reboot",
      blocks: [],
    });
    assert.equal(results.children.length, 2);
    const cardB = results.children[0];
    assert.equal(cardB.dataset.resultTitle, "Reboot");
    const prevDetails = h.elements["rich-previous-result"];
    const prevBody = prevDetails.querySelector(".rich-prev-body");
    assert.equal(prevBody.children.length, 1);
    assert.equal(cardA1.parentElement, prevBody);

    // 3. Re-invoke action A: must create fresh card for A, and prevDetails must now hold B
    ws.receiveFrame({
      v: 1,
      type: "view",
      id: "v:3",
      node: "network.interfaces",
      title: "Interfaces",
      blocks: [],
    });
    assert.equal(results.children.length, 2);
    const cardA2 = results.children[0];
    assert.equal(cardA2.dataset.resultTitle, "Interfaces");
    assert.notEqual(cardA2, cardA1, "Re-invoked card must be a fresh element");
    assert.equal(prevBody.children.length, 1);
    assert.equal(cardB.parentElement, prevBody);
  });

  it("Item 8: independent side-mirror panel opens second socket mode=thin session=default", () => {
    const h = createUxRound2TestHarness();
    const ws1 = h.latestWs();
    ws1.open();
    const hello1 = JSON.parse(ws1.sent[0]);
    ws1.receiveFrame({ v: 1, type: "welcome", id: hello1.id, mode: "rich", session: "new" });

    assert.equal(h.instances.length, 1, "Initially only 1 main WebSocket exists");

    // Turn on side mirror
    const toggle = h.elements["toggle-side-mirror"];
    toggle.checked = true;
    toggle.dispatchEvent({ type: "change" });

    assert.equal(h.instances.length, 2, "Opening side mirror opens second WebSocket");
    const ws2 = h.instances[1];
    assert.notEqual(ws1, ws2, "Second socket is a distinct instance");
    ws2.open();

    // Verify hello on second socket: mode=thin, session=default
    const hello2 = JSON.parse(ws2.sent[0]);
    assert.equal(hello2.type, "hello");
    assert.equal(hello2.mode, "thin");
    assert.equal(hello2.session, "default");
    assert.equal(hello2.client.name, "wlanpi-webui-side-mirror");

    ws2.receiveFrame({ v: 1, type: "welcome", id: hello2.id, mode: "thin", session: "default" });
    assert.equal(h.elements["side-mirror-status"].textContent, "Active (thin:default)");

    // Receive view frame on side mirror socket
    ws2.receiveFrame({
      v: 1,
      type: "view",
      id: "smv:1",
      screen: "menu",
      title: "Panel Main Menu",
      breadcrumb: ["Home", "Network"],
      driven_by: { principal: { name: "Operator", kind: "user" }, surface: "front-panel", self: false },
      blocks: [{ type: "text", text: "Side mirror active" }],
    });

    assert.equal(h.elements["side-mirror-title"].textContent, "Panel Main Menu");
    assert.equal(h.elements["side-mirror-breadcrumb"].textContent, "Home > Network");
    assert.ok(h.elements["side-mirror-driven-by"].textContent.includes("Operator (front-panel)"));

    // Send input via side mirror D-pad
    const dpadBtn = new h.elements["menu-panel"].constructor("dpad-btn");
    dpadBtn.setAttribute("data-side-dpad-key", "center");
    h.elements["menu-panel"].dispatchEvent({
      type: "click",
      target: dpadBtn,
    });

    const sideInp = ws2.sent.map((s) => JSON.parse(s)).find((f) => f.type === "input");
    assert.ok(sideInp, "Input should be sent on side mirror WebSocket");
    assert.equal(sideInp.key, "center");

    // Main socket must NOT have sent input
    const mainInp = ws1.sent.map((s) => JSON.parse(s)).find((f) => f.type === "input");
    assert.ok(!mainInp, "Main rich socket must NOT send input frame");

    // Close side mirror
    const closeBtn = h.elements["close-side-mirror"];
    closeBtn.dispatchEvent({ type: "click" });

    assert.equal(ws2.readyState, 3, "Second socket closed on close");
    assert.equal(ws1.readyState, 1, "Main socket remains OPEN");
    assert.equal(h.elements["side-mirror-container"].style.display, "none");
  });
});

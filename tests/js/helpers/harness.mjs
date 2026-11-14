// Shared test harness for the menu page suites.
//
// - Every frame a client-side module builds is validated against the vendored
//   frames.schema.json (ajv), so client drift fails here, not in the container.
// - DOM suites run on jsdom, not hand-written mocks: `children` is a real
//   HTMLCollection (no indexOf, no forEach), as in a browser.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020");
const { JSDOM } = require("jsdom");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../../..");
export const STATIC = path.join(ROOT, "wlanpi_webui/static");
export const SAMPLES = path.resolve(ROOT, "../wlanpi-menud/protocol/samples/frames");

export const schemaDoc = JSON.parse(fs.readFileSync(path.join(ROOT, "protocol/frames.schema.json"), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema(schemaDoc, "frames");
const validators = {};
function validatorFor(type) {
  if (!validators[type]) {
    assert.ok(schemaDoc.$defs[type], `frames.schema.json has no $defs.${type}`);
    validators[type] = ajv.compile({ $ref: `frames#/$defs/${type}` });
  }
  return validators[type];
}

const C2S = ["hello", "subscribe", "unsubscribe", "input", "invoke", "answer", "page", "cancel", "complications.configure"];

/** A frame the browser sends must be a valid client-to-server frame. */
export function assertC2S(frame) {
  assert.ok(frame && typeof frame === "object", "frame is an object");
  assert.ok(C2S.includes(frame.type), `client sent a ${frame.type} frame, which the browser must not send`);
  const v = validatorFor(frame.type.replace(/\./g, "_"));
  assert.ok(v(frame), `${frame.type} frame breaks frames.schema.json: ${JSON.stringify(v.errors)}\n${JSON.stringify(frame)}`);
}

/** Fixtures the tests feed in must be valid server-to-client frames too. */
export function assertS2C(frame) {
  const v = validatorFor(frame.type.replace(/\./g, "_"));
  assert.ok(v(frame), `${frame.type} fixture breaks frames.schema.json: ${JSON.stringify(v.errors)}\n${JSON.stringify(frame)}`);
  return frame;
}

export function sample(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES, dir, name), "utf8"));
}

// ---------------------------------------------------------------- fake timers

export class FakeTimers {
  constructor(start = 1_700_000_000_000) {
    this.t = start;
    this.seq = 0;
    this.timers = new Map();
    this.setTimeout = (fn, ms) => {
      const id = ++this.seq;
      this.timers.set(id, { at: this.t + Math.max(0, ms || 0), fn, every: null });
      return id;
    };
    this.clearTimeout = (id) => { this.timers.delete(id); };
    this.setInterval = (fn, ms) => {
      const id = ++this.seq;
      this.timers.set(id, { at: this.t + ms, fn, every: ms });
      return id;
    };
    this.clearInterval = this.clearTimeout;
    this.now = () => this.t;
  }

  get pending() {
    return this.timers.size;
  }

  /** Move the clock forward, firing due timers in order. */
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      let next = null;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && (next === null || tm.at < next.tm.at)) next = { id, tm };
      }
      if (!next) break;
      this.t = Math.max(this.t, next.tm.at);
      if (next.tm.every) {
        next.tm.at += next.tm.every;
      } else {
        this.timers.delete(next.id);
      }
      next.tm.fn();
    }
    this.t = end;
  }
}

// ---------------------------------------------------------------- fake socket

/** Returns a WebSocket constructor whose instances are recorded on `.sockets`. */
export function fakeSocketFactory() {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      this.closed = null;
      sockets.push(this);
    }

    send(data) {
      const frame = JSON.parse(data);
      assertC2S(frame);
      this.sent.push(frame);
    }

    close(code, reason) {
      this.closed = { code, reason, byClient: true };
      this.readyState = 3;
    }

    // -- test controls --
    open() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }

    receive(frame) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) });
    }

    serverClose(code) {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code });
    }

    ofType(type) {
      return this.sent.filter((f) => f.type === type);
    }
  }
  FakeSocket.sockets = sockets;
  FakeSocket.last = () => sockets[sockets.length - 1];
  return FakeSocket;
}

// ---------------------------------------------------------------- frames

const PRINCIPAL = { kind: "webui", name: "alice" };

export function welcome(extra = {}) {
  return assertS2C({
    v: 1, type: "welcome", id: "c1", session_id: "sess-0001", session: "new", epoch: "epoch-0001", version: 1,
    mode: "rich", resumed: false, principal: PRINCIPAL, roles: ["admin"],
    limits: { queue_frames: 64, max_frame_bytes: 1048576 }, ...extra,
  });
}

/**
 * A schema-valid menu that exercises every row cue and run policy. Ids are
 * test-only so nothing here depends on the built-in manifest.
 */
export function menuFrame(extra = {}) {
  const nodes = [
    { id: "net", label: "Net", parent: null, order: 10, kind: "branch" },
    { id: "net.ifaces", label: "Ifaces", parent: "net", order: 10, kind: "action", view: "table", cancellable: false, mutates: false },
    { id: "net.public", label: "Public Address", parent: "net", order: 20, kind: "action", view: "kv", cancellable: false, mutates: false },
    { id: "tools", label: "Tools", parent: null, order: 20, kind: "branch" },
    {
      id: "tools.survey", label: "Survey", parent: "tools", order: 10, kind: "action", view: "table", cancellable: true, mutates: false,
      params: [{ name: "adapter", label: "Adapter", type: "adapter", kind: "wlan", monitor: true, required: false }],
    },
    { id: "tools.speed", label: "Speed", parent: "tools", order: 20, kind: "action", view: "kv", cancellable: true, mutates: false },
    { id: "tools.radio_on", label: "Radio On", parent: "tools", order: 30, kind: "action", view: "status", cancellable: false, mutates: true },
    { id: "tools.legacy", label: "Legacy Thing", parent: "tools", order: 40, kind: "action" },
    { id: "tools.plugin", label: "Plugin Thing", parent: "tools", order: 50, kind: "action", mutates: false, provider: "acme" },
    { id: "tools.capture", label: "Capture", parent: "tools", order: 60, kind: "branch" },
    { id: "tools.capture.more", label: "More Capture", parent: "tools.capture", order: 10, kind: "branch" },
    { id: "tools.capture.more.start", label: "Begin", parent: "tools.capture.more", order: 10, kind: "action", cancellable: true, mutates: true },
    { id: "sys", label: "Sys", parent: null, order: 30, kind: "branch" },
    {
      id: "sys.restart", label: "Restart", parent: "sys", order: 10, kind: "action", view: "status", cancellable: false, mutates: true,
      confirm: { title: "Restart", message: "Restart the device now?", confirm_label: "Restart", cancel_label: "Keep running" },
    },
    {
      id: "sys.region", label: "Set Region", parent: "sys", order: 20, kind: "action", view: "status", cancellable: false, mutates: true,
      params: [
        { name: "country", label: "Country", type: "enum", choices: [{ value: "US", label: "US" }, { value: "CZ", label: "CZ" }] },
        { name: "power", label: "Power", type: "integer", minimum: 1, maximum: 30, default: 20, required: false },
        { name: "note", label: "Note", type: "string", max_length: 16, required: false },
      ],
    },
    { id: "sys.empty", label: "Empty", parent: "sys", order: 30, kind: "branch" },
  ];
  return assertS2C({ v: 1, type: "menu", id: "s:1", revision: 1, device_mode: "classic", nodes, ...extra });
}

export function event(topic, seq, data, extra = {}) {
  return assertS2C({ v: 1, type: "event", id: "s:e" + topic + seq, topic, seq, data, ...extra });
}

export const SUMMARY = {
  hostname: "wlanpi-a1b2", model: "WLAN Pi Pro", mode: "classic", software_version: "3.4.0", ip: "192.168.1.42",
  eth0: "192.168.1.42", wlan0: null, cpu: "3%", cpu_temp: "48.2C", uptime: "2 d 4 h",
  battery: { present: true, percent: 87, status: "Charging" }, bluetooth_on: false, profiler_running: false,
  reachable: true, wlan_adapters: ["wlan0", "wlan1"], hotspot_clients: null,
};

export function summaryEvent(seq = 1, data = SUMMARY, extra = { snapshot: true }) {
  return event("device.summary", seq, data, extra);
}

export function job(node, state, extra = {}) {
  return assertS2C({ v: 1, type: "job", id: "s:j", job_id: "j001", node, state, ...extra });
}

export function tableBlock(rows, columns) {
  columns = columns || [
    { key: "name", label: "Name" }, { key: "state", label: "State", priority: 1 },
    { key: "mac", label: "MAC", priority: 3 }, { key: "speed", label: "Speed", align: "right", priority: 2 },
  ];
  return { type: "table", text: rows.length + " rows", columns, rows };
}

export function rowsFrom(start, count) {
  const out = [];
  for (let i = start; i < start + count; i++) out.push(["row" + i, "up", "00:00:00:00:00:" + String(i % 100).padStart(2, "0"), i]);
  return out;
}

// ---------------------------------------------------------------- DOM

/** The real /menu partial, without the Jinja comment. */
export function menuPartial() {
  const raw = fs.readFileSync(path.join(ROOT, "wlanpi_webui/templates/partials/menu.html"), "utf8");
  return raw.replace(/\{#[\s\S]*?#\}/g, "");
}

/**
 * A jsdom window showing the real menu shell inside the app's #content.
 * @returns {{ window, document, panel }}
 */
export function makeDom({ hash = "", search = "", html } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html lang="en"><body><a class="skip-link" href="#content">Skip to content</a>` +
      `<main id="content">${html === undefined ? menuPartial() : html}</main></body></html>`,
    { url: `https://wlanpi.test/menu${search}${hash}`, pretendToBeVisual: true }
  );
  const window = dom.window;
  return { dom, window, document: window.document, panel: window.document.getElementById("menu-panel") };
}

export function click(el) {
  assert.ok(el, "element to click exists");
  const win = el.ownerDocument.defaultView;
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

export function key(el, k, extra = {}) {
  const win = el.ownerDocument.defaultView;
  const evt = new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra });
  el.dispatchEvent(evt);
  return evt;
}

export function setHash(window, hash) {
  window.location.hash = hash;
  // jsdom queues hashchange as a task; dispatch it now so tests stay synchronous.
  window.dispatchEvent(new window.HashChangeEvent("hashchange"));
}

export function text(el) {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

export const load = (rel) => require(path.join(STATIC, "js", rel));

// Boots the real menu page (main.js and everything under it) on jsdom with a
// fake socket, so suites drive it the way a browser would: clicks and frames.
import * as H from "./harness.mjs";

const Main = H.load("menu/main.js");

export class MemoryStorage {
  constructor(init = {}) { this.data = { ...init }; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; }
  setItem(k, v) { this.data[k] = String(v); }
}

/**
 * @param {object} o  hash, search, storage, live (default true: handshake, menu and device summary delivered)
 */
export function boot(o = {}) {
  Main.forgetSaved();
  const dom = o.dom || H.makeDom({ hash: o.hash || "", search: o.search || "" });
  const { window, panel } = dom;
  const WS = o.WS || H.fakeSocketFactory();
  const timers = o.timers || new H.FakeTimers();
  const storage = o.storage === undefined ? new MemoryStorage() : o.storage;
  const app = Main.createApp({
    win: window, panel, WebSocket: WS, storage,
    now: timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval, random: () => 0.5,
    checkSignedOut: o.checkSignedOut || (() => null),
  });
  const ctx = {
    app, window, document: window.document, panel, WS, timers, storage,
    /** The menu connection's socket (the first one opened, or the latest after reconnects). */
    /** The menu connection's current socket, and the pane's (null while closed or between retries). */
    get ws() { return app.connections().menu.ws; },
    get paneWs() { const c = app.connections().frontPanel; return c ? c.ws : null; },
    $: (sel) => panel.querySelector(sel),
    $$: (sel) => Array.from(panel.querySelectorAll(sel)),
    page: () => panel.querySelector("#menu-page"),
    go(hash) { H.setHash(window, hash); },
    invokes(node) { return allSent(WS, "invoke").filter((f) => !node || f.node === node); },
    sent(type) { return allSent(WS, type); },
    /** Answer the newest invoke for `node` with a result. */
    finish(node, blocks, extra = {}) {
      const inv = ctx.invokes(node).pop();
      ctx.ws.receive(H.job(node, "queued", { id: inv.id, job_id: extra.job_id || "j001" }));
      ctx.ws.receive(H.job(node, "result", { job_id: extra.job_id || "j001", result: { blocks, ...(extra.result || {}) } }));
    },
  };
  if (o.live !== false) {
    const ws = ctx.ws;
    ws.open();
    ws.receive(H.welcome(o.welcome || {}));
    ws.receive(o.menu || H.menuFrame());
    ws.receive(H.summaryEvent(1, o.summary || H.SUMMARY));
    ws.receive(H.event("alerts", 1, o.alerts || [], { snapshot: true }));
    ws.receive(H.event("complications", 1, o.complications || [], { snapshot: true }));
    ws.receive(H.event("jobs", 1, [], { snapshot: true }));
  }
  return ctx;
}

// The pane's hello is the only thin one; that tells the two connections apart.
function isPane(ws) {
  return ws.sent.length > 0 && ws.sent[0].type === "hello" && ws.sent[0].mode === "thin";
}

export function menuSockets(WS) {
  return WS.sockets.filter((ws) => ws.sent.length > 0 && !isPane(ws));
}

export function paneSockets(WS) {
  return WS.sockets.filter(isPane);
}

function allSent(WS, type) {
  const out = [];
  for (const ws of menuSockets(WS)) for (const f of ws.sent) if (f.type === type) out.push(f);
  return out;
}

export { Main };

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeTimers, fakeSocketFactory, load, sample, welcome, assertC2S } from "./helpers/harness.mjs";

const MenuConnection = load("menu/connection.js");
const { PHASE, REASON } = MenuConnection;

class FakeTarget {
  constructor() { this.listeners = {}; this.hidden = false; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  fire(t) { (this.listeners[t] || []).slice().forEach((fn) => fn({ type: t })); }
  count(t) { return (this.listeners[t] || []).length; }
}

function setup(extra = {}) {
  const timers = new FakeTimers();
  const WS = fakeSocketFactory();
  const doc = new FakeTarget();
  const win = new FakeTarget();
  const states = [];
  const frames = [];
  const conn = new MenuConnection({
    url: "wss://wlanpi.test/ui/ws", WebSocket: WS,
    hello: { mode: "rich", session: "new", client: { name: "wlanpi-webui" } },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: timers.now,
    random: () => 0.5, // no jitter unless a test asks for it
    doc, win,
    onState: (s) => states.push(s),
    onFrame: (f) => frames.push(f),
    ...extra,
  });
  return { conn, timers, WS, doc, win, states, frames };
}

function goLive(ctx, w = welcome()) {
  ctx.conn.start();
  const ws = ctx.WS.last();
  ws.open();
  ws.receive(w);
  return ws;
}

describe("MenuConnection handshake", () => {
  it("walks idle -> connecting -> handshaking -> live and sends a schema-valid rich hello", () => {
    const ctx = setup();
    assert.equal(ctx.conn.state.phase, PHASE.IDLE);
    ctx.conn.start();
    assert.equal(ctx.conn.state.phase, PHASE.CONNECTING);
    const ws = ctx.WS.last();
    assert.equal(ws.url, "wss://wlanpi.test/ui/ws");
    ws.open();
    assert.equal(ctx.conn.state.phase, PHASE.HANDSHAKING);
    assert.equal(ws.sent.length, 1);
    const hello = ws.sent[0];
    assert.equal(hello.type, "hello");
    assert.equal(hello.mode, "rich");
    assert.equal(hello.session, "new");
    assert.deepEqual(hello.protocol, [1]);
    assert.equal(hello.resume, undefined, "first hello carries no resume");
    ws.receive(welcome());
    assert.equal(ctx.conn.state.phase, PHASE.LIVE);
    assert.ok(ctx.conn.isLive());
    assert.deepEqual(ctx.states.map((s) => s.phase), [PHASE.CONNECTING, PHASE.HANDSHAKING, PHASE.LIVE]);
    assert.equal(ctx.frames[0].type, "welcome");
  });

  it("send() returns a request id when live and null otherwise, and never raises", () => {
    const ctx = setup();
    assert.equal(ctx.conn.send({ type: "invoke", node: "a.b" }), null);
    const ws = goLive(ctx);
    const id = ctx.conn.send({ type: "invoke", node: "a.b" });
    assert.equal(typeof id, "string");
    assert.deepEqual(ws.sent[1], { v: 1, id, type: "invoke", node: "a.b" });
    const id2 = ctx.conn.send({ type: "subscribe", topics: ["jobs"] });
    assert.notEqual(id, id2, "request ids are unique per connection");
  });

  it("the thin hello for the pane is schema-valid too", () => {
    const ctx = setup({ hello: { mode: "thin", session: "default", client: { name: "x" } } });
    ctx.conn.start();
    ctx.WS.last().open();
    assert.equal(ctx.WS.last().sent[0].session, "default");
  });
});

describe("MenuConnection backoff", () => {
  it("retries with 1, 2, 4, 8, 15, 30 s capped at 30 s, with a visible countdown", () => {
    const ctx = setup();
    goLive(ctx).serverClose(1006);
    const seen = [];
    for (let i = 0; i < 8; i++) {
      assert.equal(ctx.conn.state.phase, PHASE.WAITING);
      assert.equal(ctx.conn.state.reason, REASON.LOST);
      seen.push(ctx.conn.state.retryInSec);
      ctx.timers.advance(ctx.conn.state.retryInSec * 1000);
      assert.equal(ctx.conn.state.phase, PHASE.CONNECTING, "timer fired: reconnecting");
      ctx.WS.last().serverClose(1006);
    }
    assert.deepEqual(seen, [1, 2, 4, 8, 15, 30, 30, 30]);
    assert.deepEqual(MenuConnection.BACKOFF_SEC, [1, 2, 4, 8, 15, 30]);
  });

  it("ticks the countdown down once per second", () => {
    const ctx = setup();
    const ws = goLive(ctx);
    ws.serverClose(1006); // 1 s
    ctx.timers.advance(1000);
    ctx.WS.last().serverClose(1006); // 2 s
    ctx.timers.advance(2000);
    ctx.WS.last().serverClose(1006); // 4 s
    const counts = [ctx.conn.state.retryInSec];
    for (let i = 0; i < 3; i++) {
      ctx.timers.advance(1000);
      counts.push(ctx.conn.state.retryInSec);
    }
    assert.deepEqual(counts, [4, 3, 2, 1]);
    ctx.timers.advance(1000);
    assert.equal(ctx.conn.state.phase, PHASE.CONNECTING);
  });

  it("applies +/-20 % jitter and stays inside the bounds", () => {
    for (const [r, want] of [[0, 800], [1, 1200], [0.5, 1000]]) {
      const ctx = setup({ random: () => r });
      goLive(ctx).serverClose(1006);
      // The reconnect happens exactly at the jittered delay, not before.
      ctx.timers.advance(want - 1);
      assert.equal(ctx.conn.state.phase, PHASE.WAITING, `r=${r}: still waiting at ${want - 1} ms`);
      ctx.timers.advance(1);
      assert.equal(ctx.conn.state.phase, PHASE.CONNECTING, `r=${r}: reconnects at ${want} ms`);
    }
    assert.equal(MenuConnection.JITTER, 0.2);
  });

  it("resets the backoff after a welcome", () => {
    const ctx = setup();
    goLive(ctx).serverClose(1006);
    ctx.timers.advance(1000);
    ctx.WS.last().serverClose(1006);
    assert.equal(ctx.conn.state.retryInSec, 2);
    ctx.timers.advance(2000);
    const ws = ctx.WS.last();
    ws.open();
    ws.receive(welcome({ resumed: true }));
    assert.equal(ctx.conn.state.attempt, 0);
    ws.serverClose(1006);
    assert.equal(ctx.conn.state.retryInSec, 1, "back to the first step");
  });

  it("Retry now reconnects at once and cancels the pending timer", () => {
    const ctx = setup();
    goLive(ctx).serverClose(1006);
    const before = ctx.WS.sockets.length;
    ctx.conn.retryNow();
    assert.equal(ctx.conn.state.phase, PHASE.CONNECTING);
    assert.equal(ctx.WS.sockets.length, before + 1);
    ctx.timers.advance(60000);
    assert.equal(ctx.WS.sockets.length, before + 1, "the old timer does not open a second socket");
  });
});

describe("MenuConnection close codes", () => {
  it("1001 is 'restarting' and retries", () => {
    const ctx = setup();
    goLive(ctx).serverClose(1001);
    assert.equal(ctx.conn.state.phase, PHASE.WAITING);
    assert.equal(ctx.conn.state.reason, REASON.RESTARTING);
    assert.equal(ctx.conn.state.retryInSec, 1);
  });

  it("1013 is 'busy' with a longer delay", () => {
    const ctx = setup();
    goLive(ctx).serverClose(1013);
    assert.equal(ctx.conn.state.reason, REASON.BUSY);
    assert.equal(ctx.conn.state.retryInSec, 10);
  });

  it("retry_after_sec on an error frame sets the busy delay", () => {
    const ctx = setup();
    const ws = goLive(ctx);
    ws.receive({ v: 1, type: "error", id: "s:0", code: "INTERNAL", message: "session limit reached", fatal: true, close_code: 1013, retry_after_sec: 25 });
    ws.serverClose(1013);
    assert.equal(ctx.conn.state.reason, REASON.BUSY);
    assert.equal(ctx.conn.state.retryInSec, 25);
  });

  for (const [code, reason] of [[4401, REASON.SIGNED_OUT], [1008, REASON.REFUSED], [4426, REASON.RELOAD_NEEDED], [4400, REASON.RELOAD_NEEDED]]) {
    it(`${code} is terminal (${reason}): no retry, no timers, listeners removed`, () => {
      const ctx = setup();
      goLive(ctx).serverClose(code);
      assert.equal(ctx.conn.state.phase, PHASE.TERMINAL);
      assert.equal(ctx.conn.state.reason, reason);
      assert.equal(ctx.timers.pending, 0);
      const n = ctx.WS.sockets.length;
      ctx.timers.advance(120000);
      ctx.win.fire("online");
      ctx.doc.fire("visibilitychange");
      ctx.conn.retryNow();
      assert.equal(ctx.WS.sockets.length, n, "never reconnects");
      assert.equal(ctx.win.count("online"), 0);
    });
  }

  it("AUTH_FAILED error frame makes the close terminal even with another code", () => {
    const ctx = setup();
    const ws = goLive(ctx);
    ws.receive(sample("s2c", "error.auth.json"));
    ws.serverClose(1006);
    assert.equal(ctx.conn.state.phase, PHASE.TERMINAL);
    assert.equal(ctx.conn.state.reason, REASON.SIGNED_OUT);
  });

  it("a socket that never opened asks the page whether the login is gone", async () => {
    let asked = 0;
    const ctx = setup({ checkSignedOut: () => { asked += 1; return Promise.resolve(true); } });
    ctx.conn.start();
    ctx.WS.last().serverClose(1006); // nginx answered the upgrade with 401
    assert.equal(ctx.conn.state.phase, PHASE.WAITING);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(asked, 1);
    assert.equal(ctx.conn.state.phase, PHASE.TERMINAL);
    assert.equal(ctx.conn.state.reason, REASON.SIGNED_OUT);
    assert.equal(ctx.timers.pending, 0);
  });

  it("a socket that did open does not ask, and a 'still signed in' answer keeps retrying", async () => {
    let asked = 0;
    const ctx = setup({ checkSignedOut: () => { asked += 1; return Promise.resolve(false); } });
    goLive(ctx).serverClose(1006);
    assert.equal(asked, 0);
    ctx.timers.advance(1000);
    ctx.WS.last().serverClose(1006);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(asked, 1);
    assert.equal(ctx.conn.state.phase, PHASE.WAITING);
  });

  it("classifyClose covers the table", () => {
    const c = MenuConnection.classifyClose;
    assert.deepEqual(c(1006), { terminal: false, reason: REASON.LOST });
    assert.deepEqual(c(1000), { terminal: false, reason: REASON.LOST });
    assert.deepEqual(c(1001), { terminal: false, reason: REASON.RESTARTING });
    assert.deepEqual(c(1013), { terminal: false, reason: REASON.BUSY });
    assert.deepEqual(c(4401), { terminal: true, reason: REASON.SIGNED_OUT });
  });
});

describe("MenuConnection page and network events", () => {
  it("runs no timers while the tab is hidden and reconnects when it becomes visible", () => {
    const ctx = setup();
    const ws = goLive(ctx);
    ctx.doc.hidden = true;
    ws.serverClose(1006);
    assert.equal(ctx.conn.state.phase, PHASE.WAITING);
    assert.equal(ctx.conn.state.paused, true);
    assert.equal(ctx.conn.state.retryInSec, null);
    assert.equal(ctx.timers.pending, 0, "no timer while hidden");
    const n = ctx.WS.sockets.length;
    ctx.timers.advance(600000);
    assert.equal(ctx.WS.sockets.length, n);
    ctx.doc.hidden = false;
    ctx.doc.fire("visibilitychange");
    assert.equal(ctx.conn.state.phase, PHASE.CONNECTING);
    assert.equal(ctx.WS.sockets.length, n + 1);
  });

  it("stops a running countdown when the tab is hidden", () => {
    const ctx = setup();
    goLive(ctx).serverClose(1006);
    assert.equal(ctx.timers.pending, 1);
    ctx.doc.hidden = true;
    ctx.doc.fire("visibilitychange");
    assert.equal(ctx.timers.pending, 0);
    assert.equal(ctx.conn.state.paused, true);
  });

  it("reconnects at once on the browser online event", () => {
    const ctx = setup();
    goLive(ctx).serverClose(1006);
    ctx.timers.advance(1000);
    ctx.WS.last().serverClose(1006);
    ctx.timers.advance(2000);
    ctx.WS.last().serverClose(1006);
    assert.equal(ctx.conn.state.retryInSec, 4);
    const n = ctx.WS.sockets.length;
    ctx.win.fire("online");
    assert.equal(ctx.WS.sockets.length, n + 1);
    assert.equal(ctx.conn.state.phase, PHASE.CONNECTING);
  });

  it("online while live does nothing", () => {
    const ctx = setup();
    goLive(ctx);
    ctx.win.fire("online");
    assert.equal(ctx.WS.sockets.length, 1);
    assert.equal(ctx.conn.state.phase, PHASE.LIVE);
  });
});

describe("MenuConnection resume", () => {
  it("sends hello.resume with the epoch, session id, per-topic seq and menu revision", () => {
    const ctx = setup();
    const ws = goLive(ctx, welcome({ epoch: "epoch-0009", session_id: "sess-9" }));
    ws.receive({ v: 1, type: "menu", id: "s:1", revision: 7, nodes: [] });
    ws.receive({ v: 1, type: "event", id: "s:2", topic: "device.summary", seq: 3, snapshot: true, data: {} });
    ws.receive({ v: 1, type: "event", id: "s:3", topic: "device.summary", seq: 4, data: {} });
    ws.receive({ v: 1, type: "event", id: "s:4", topic: "jobs", seq: 12, snapshot: true, data: [] });
    ws.serverClose(1006);
    ctx.timers.advance(1000);
    const ws2 = ctx.WS.last();
    ws2.open();
    const hello = ws2.sent[0];
    assert.deepEqual(hello.resume, {
      epoch: "epoch-0009", session_id: "sess-9", seq: { "device.summary": 4, jobs: 12 }, menu_revision: 7,
    });
    // The recorded sample has the same shape.
    const recorded = sample("c2s", "hello.rich-resume.json");
    assertC2S(recorded);
    assert.deepEqual(Object.keys(hello.resume).sort(), Object.keys(recorded.resume).sort());
  });

  it("a new epoch replaces the resume material", () => {
    const ctx = setup();
    const ws = goLive(ctx, welcome({ epoch: "epoch-0001", session_id: "s-1" }));
    ws.receive({ v: 1, type: "event", id: "s:2", topic: "jobs", seq: 5, snapshot: true, data: [] });
    ws.serverClose(1001);
    ctx.timers.advance(1000);
    const ws2 = ctx.WS.last();
    ws2.open();
    ws2.receive(welcome({ epoch: "epoch-0002", session_id: "s-2", resumed: false }));
    assert.deepEqual(ctx.conn.getResume(), { epoch: "epoch-0002", session_id: "s-2", seq: {} });
  });

  it("setResume lets a returning page resume (carried over an in-app page swap)", () => {
    const ctx = setup();
    ctx.conn.setResume({ epoch: "epoch-0001", session_id: "s-1", seq: { jobs: 2 }, menu_revision: 3 });
    ctx.conn.start();
    ctx.WS.last().open();
    assert.deepEqual(ctx.WS.last().sent[0].resume, { epoch: "epoch-0001", session_id: "s-1", seq: { jobs: 2 }, menu_revision: 3 });
  });
});

describe("MenuConnection socket hygiene", () => {
  it("ignores events from a socket it has already replaced", () => {
    const ctx = setup();
    const ws1 = goLive(ctx);
    ws1.serverClose(1006);
    ctx.conn.retryNow();
    const ws2 = ctx.WS.last();
    ws2.open();
    ws2.receive(welcome({ resumed: true }));
    assert.equal(ctx.conn.state.phase, PHASE.LIVE);
    const frames = ctx.frames.length;
    // Late events from the dead socket must not touch the live connection.
    ws1.onclose({ code: 4401 });
    ws1.onmessage({ data: JSON.stringify(welcome()) });
    ws1.onopen({});
    assert.equal(ctx.conn.state.phase, PHASE.LIVE);
    assert.equal(ctx.frames.length, frames);
    assert.equal(ws1.sent.length, 1, "no second hello on the dead socket");
  });

  it("close() by the client ends in idle with code 1000 and never reconnects", () => {
    const ctx = setup();
    const ws = goLive(ctx);
    ctx.conn.close();
    assert.deepEqual(ws.closed, { code: 1000, reason: "client closed", byClient: true });
    assert.equal(ctx.conn.state.phase, PHASE.IDLE);
    ws.onclose({ code: 1000 }); // the browser reports the close afterwards
    ctx.timers.advance(120000);
    ctx.win.fire("online");
    assert.equal(ctx.WS.sockets.length, 1, "no reconnect loop after a client close");
    assert.equal(ctx.timers.pending, 0);
    assert.equal(ctx.win.count("online"), 0);
    assert.equal(ctx.doc.count("visibilitychange"), 0);
  });

  it("close() while waiting cancels the retry", () => {
    const ctx = setup();
    goLive(ctx).serverClose(1006);
    ctx.conn.close();
    ctx.timers.advance(60000);
    assert.equal(ctx.WS.sockets.length, 1);
    assert.equal(ctx.conn.state.phase, PHASE.IDLE);
  });

  it("malformed messages are dropped", () => {
    const ctx = setup();
    const ws = goLive(ctx);
    ws.onmessage({ data: "not json" });
    ws.onmessage({ data: "42" });
    assert.equal(ctx.conn.state.phase, PHASE.LIVE);
    assert.equal(ctx.frames.length, 1);
  });

  it("a constructor that throws is treated as a lost connection", () => {
    const timers = new FakeTimers();
    const conn = new MenuConnection({
      url: "x", WebSocket: function () { throw new Error("blocked"); },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: timers.now, random: () => 0.5,
    });
    conn.start();
    assert.equal(conn.state.phase, PHASE.WAITING);
    assert.equal(conn.state.reason, REASON.LOST);
  });
});

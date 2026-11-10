import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { load, menuFrame, welcome, makeDom, setHash, assertS2C } from "./helpers/harness.mjs";

const Store = load("menu/store.js");
const Router = load("menu/router.js");
const { TYPE } = Router;

function state(menu = menuFrame()) {
  let s = Store.applyFrame(Store.createState(), welcome(), 0);
  return Store.applyFrame(s, menu, 0);
}

describe("MenuRouter hash round-trip", () => {
  it("round-trips dotted node ids unchanged", () => {
    for (const id of ["net", "net.ifaces", "tools.capture.more.start", "plugin.acme.thing_1", "a.b-c.d"]) {
      const href = Router.hrefFor(id);
      assert.equal(href, "#" + id, "the hash is the node id as sent");
      assert.equal(Router.parseHash(href), id);
    }
  });

  it("empty hash is Home", () => {
    assert.equal(Router.hrefFor(""), "#");
    assert.equal(Router.hrefFor(null), "#");
    assert.equal(Router.parseHash(""), "");
    assert.equal(Router.parseHash("#"), "");
    assert.equal(Router.parseHash(undefined), "");
  });

  it("escapes characters that are not safe in a hash and reads them back", () => {
    const id = "odd id/with?chars#x";
    const href = Router.hrefFor(id);
    assert.ok(!/[ ?]/.test(href.slice(1)));
    assert.equal(Router.parseHash(href), id);
    assert.equal(Router.parseHash("#%E0%A4%A"), "%E0%A4%A", "a malformed escape is taken literally, not thrown");
  });

  it("survives a real location round-trip (jsdom)", () => {
    const { window } = makeDom();
    window.location.hash = Router.hrefFor("tools.capture.more.start");
    assert.equal(Router.parseHash(window.location.hash), "tools.capture.more.start");
  });
});

describe("MenuRouter.resolve", () => {
  it("is loading until a menu arrives, keeping the requested id", () => {
    assert.deepEqual(Router.resolve(Store.createState(), "#net.ifaces"), { type: TYPE.LOADING, id: "net.ifaces", node: null });
  });

  it("resolves home, branch and action", () => {
    const s = state();
    assert.equal(Router.resolve(s, "").type, TYPE.HOME);
    assert.equal(Router.resolve(s, "#").type, TYPE.HOME);
    const b = Router.resolve(s, "#tools.capture");
    assert.equal(b.type, TYPE.BRANCH);
    assert.equal(b.node.label, "Capture");
    const a = Router.resolve(s, "#net.ifaces");
    assert.equal(a.type, TYPE.ACTION);
    assert.equal(a.node.id, "net.ifaces");
  });

  it("unknown, hidden and mistyped ids resolve to not-available, never an error", () => {
    const s = state();
    for (const h of ["#nope", "#net.ifaces.extra", "#NET", "#constructor", "#__proto__", "#toString"]) {
      const r = Router.resolve(s, h);
      assert.equal(r.type, TYPE.NOT_AVAILABLE, h);
      assert.equal(r.node, null);
    }
  });

  it("a node removed by a menu replacement becomes not-available; one that stays is kept", () => {
    const m = menuFrame();
    let s = state(m);
    assert.equal(Router.resolve(s, "#tools.survey").type, TYPE.ACTION);
    const afterModeSwitch = assertS2C({ ...m, revision: 2, nodes: m.nodes.filter((n) => !n.id.startsWith("tools")) });
    s = Store.applyFrame(s, afterModeSwitch, 0);
    assert.equal(Router.resolve(s, "#tools.survey").type, TYPE.NOT_AVAILABLE);
    assert.equal(Router.resolve(s, "#net.ifaces").type, TYPE.ACTION);
  });
});

describe("MenuRouter.subscribe", () => {
  it("reports hash changes and stops after unsubscribe", () => {
    const { window } = makeDom();
    const seen = [];
    const stop = Router.subscribe(window, (h) => seen.push(h));
    setHash(window, "#net");
    setHash(window, "#net.ifaces");
    stop();
    setHash(window, "#sys");
    assert.deepEqual(seen, ["#net", "#net.ifaces"]);
  });

  it("navigate sets the hash and reports whether it changed", () => {
    const { window } = makeDom();
    assert.equal(Router.navigate(window, "net"), true);
    assert.equal(window.location.hash, "#net");
    assert.equal(Router.navigate(window, "net"), false);
  });
});

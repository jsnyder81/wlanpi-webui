// Status tiles (complications.2): wlanpi-menud docs/complications-spec.md
// sections 2.6, 4.3 to 4.7 and the WebUI row of 6.3.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as H from "./helpers/harness.mjs";
import { boot, paneSockets } from "./helpers/app.mjs";

const Store = H.load("menu/store.js");
const Pages = H.load("menu/pages.js");
const Router = H.load("menu/router.js");
const { click, text } = H;

const VECTORS = path.resolve(H.ROOT, "../wlanpi-menud/protocol/samples/complications/resolve-vectors.json");
const FEATURES = { features: ["complications.2"] };

const LIVE = [
  { app_id: "local.wlanpi.vpn", label: "VPN", value: "up", status: "ok" },
  { app_id: "plugin.acme.uplink", label: "Uplink", value: "412 Mb/s", status: "ok", short: "412", detail: "WAN2, 14 ms", icon: "globe" },
  { app_id: "wlanpi.battery", label: "Batt", value: "15%", status: "warn", short: "15%", icon: "battery" },
  { app_id: "wlanpi.cpu_temp", label: "Temp", value: "84C", status: "error", short: "84C", icon: "thermometer" },
  { app_id: "wlanpi.internet", label: "Internet", value: "up", status: "unknown", short: "NET", icon: "globe" },
  { app_id: "wlanpi.ip", label: "IP", value: "192.0.2.10", status: "ok", icon: "ethernet" },
  { app_id: "wlanpi.mode", label: "Mode", value: "Classic", status: "info", short: "CLS", icon: "dot" },
  { app_id: "wlanpi.profiler", label: "Profiler", value: "stopped", status: "off", short: "PRF", icon: "radio" },
];

const CATALOG = [
  { app_id: "local.wlanpi.vpn", title: "VPN", label: "VPN", source: "local" },
  { app_id: "plugin.acme.uplink", title: "Acme uplink speed", label: "Uplink", source: "plugin", description: "Measured WAN throughput." },
  { app_id: "plugin.acme.idle", title: "Acme idle", label: "Idle", source: "plugin" },
  { app_id: "wlanpi.battery", title: "Battery level", label: "Batt", source: "builtin" },
  { app_id: "wlanpi.cpu", title: "CPU load", label: "CPU", source: "builtin" },
  { app_id: "wlanpi.cpu_temp", title: "CPU temperature", label: "Temp", source: "builtin" },
  { app_id: "wlanpi.internet", title: "Internet reachability", label: "Internet", source: "builtin" },
  { app_id: "wlanpi.ip", title: "IP address", label: "IP", source: "builtin" },
  { app_id: "wlanpi.mode", title: "Device mode", label: "Mode", source: "builtin" },
  { app_id: "wlanpi.profiler", title: "Profiler state", label: "Profiler", source: "builtin" },
];

const WEBUI_SHOW = ["wlanpi.mode", "wlanpi.ip", "wlanpi.internet", "wlanpi.wifi", "wlanpi.battery", "wlanpi.cpu_temp", "wlanpi.profiler", "plugin.*", "local.*"];

function config(over = {}, seq = 1, extra = { snapshot: true }) {
  const surfaces = {
    "panel.strip": { show: ["wlanpi.battery", "wlanpi.bluetooth", "wlanpi.internet"], source: "default" },
    panel: { show: ["wlanpi.mode", "wlanpi.ip", "wlanpi.wifi", "wlanpi.cpu_temp", "wlanpi.hotspot_clients", "plugin.*", "local.*"], source: "default" },
    tui: { show: ["wlanpi.mode", "wlanpi.eth0", "wlanpi.ip", "wlanpi.cpu_temp", "plugin.*", "local.*"], source: "default" },
    webui: { show: WEBUI_SHOW, source: "default" },
    ...over,
  };
  return H.event("complications.config", seq, { surfaces }, extra);
}

/** A page on a service that has tiles, with the three new topics delivered. */
function bootTiles(o = {}) {
  const c = boot({ ...o, welcome: { ...FEATURES, ...(o.welcome || {}) } });
  c.ws.receive(H.event("complications.live", 1, o.live || LIVE, { snapshot: true }));
  c.ws.receive(H.event("complications.catalog", 1, o.catalog || CATALOG, { snapshot: true }));
  c.ws.receive(o.config || config());
  return c;
}

const barTiles = (c) => c.$$("#menu-statusbar .menu-sb-tile").map((e) => e.getAttribute("data-field"));
const configures = (c) => c.sent("complications.configure");
const rowEntries = (c, sel) => c.$$(`${sel} .menu-tiles-row`).map((e) => e.getAttribute("data-entry"));

describe("tiles: resolution (resolve-vectors.json)", { skip: !fs.existsSync(VECTORS) && "wlanpi-menud checkout not next to this repo" }, () => {
  const { cases } = fs.existsSync(VECTORS) ? JSON.parse(fs.readFileSync(VECTORS, "utf8")) : { cases: [] };

  it("has cases to run", () => assert.ok(cases.length >= 5, `cases: ${cases.length}`));

  for (const v of cases) {
    it(v.name, () => {
      let out = Store.resolveTiles(v.show, v.live);
      if (typeof v.capacity === "number") out = out.slice(0, v.capacity);
      assert.deepEqual(out, v.expect);
    });
  }

  it("reports what each entry yielded", () => {
    const counts = [];
    Store.resolveTiles(["plugin.*", "wlanpi.ip", "wlanpi.wifi"], ["plugin.a.x", "plugin.b.y", "wlanpi.ip"], counts);
    assert.deepEqual(counts, [2, 1, 0]);
  });

  it("draws an unrecognized status as unknown", () => {
    assert.equal(Store.tileStatus("critical"), "unknown");
    assert.equal(Store.tileStatus("warn"), "warn");
  });
});

describe("tiles: an older service (no complications.2)", () => {
  it("subscribes to the legacy topics only and keeps today's status bar and Home", () => {
    const c = boot({ complications: [{ app_id: "acme", label: "Acme", value: "3 clients", status: "ok" }] });
    assert.deepEqual(c.sent("subscribe")[0].topics, ["device.summary", "alerts", "complications", "jobs"]);
    assert.equal(c.$("#menu-statusbar .menu-sb-tile"), null);
    assert.ok(c.$(".menu-complications"), "the legacy list is still drawn");
    assert.equal(c.$(".menu-tiles"), null);
  });

  it("the customize page says the service has no tiles and sends nothing", () => {
    const c = boot({ hash: "#/tiles" });
    assert.equal(c.page().getAttribute("data-page"), "tiles");
    assert.match(text(c.page()), /does not offer status tiles/);
    assert.equal(configures(c).length, 0);
  });
});

describe("tiles: status bar follows the webui profile", () => {
  it("subscribes to the new topics when the welcome advertises them", () => {
    const c = bootTiles();
    assert.deepEqual(c.sent("subscribe")[0].topics, [
      "device.summary", "alerts", "complications", "jobs", "complications.live", "complications.catalog", "complications.config",
    ]);
  });

  it("draws the resolved tiles in configured order after the hostname", () => {
    const c = bootTiles();
    const bar = c.$("#menu-statusbar");
    assert.ok(bar.classList.contains("has-tiles"));
    assert.equal(bar.querySelector('[data-field="host"]').textContent, "wlanpi-a1b2");
    // wlanpi.wifi is not live: it takes no slot.
    assert.deepEqual(barTiles(c), [
      "wlanpi.mode", "wlanpi.ip", "wlanpi.internet", "wlanpi.battery", "wlanpi.cpu_temp", "wlanpi.profiler",
      "plugin.acme.uplink", "local.wlanpi.vpn",
    ]);
    assert.equal(bar.querySelector('[data-field="mode"]'), null, "no device.summary fields beside the tiles");
    assert.ok(bar.querySelector(".menu-sb-more").hidden, "no +N chip when everything fits");
  });

  it("carries the status in an icon and a word, never colour alone", () => {
    const c = bootTiles();
    const tile = (id) => c.$(`#menu-statusbar [data-field="${id}"]`);
    assert.equal(tile("wlanpi.battery").getAttribute("data-status"), "warn");
    assert.ok(tile("wlanpi.battery").querySelector('[uk-icon="icon: warning"]'));
    assert.match(text(tile("wlanpi.battery").querySelector(".menu-sb-value")), /^15%$/);
    assert.match(text(tile("wlanpi.battery")), /^Batt 15%.*Warning$/);
    assert.ok(tile("wlanpi.cpu_temp").querySelector('[uk-icon="icon: close"]'));
    assert.ok(tile("wlanpi.ip").querySelector('[uk-icon="icon: check"]'));
    assert.equal(tile("wlanpi.mode").querySelector("[uk-icon]"), null, "info has no marker");
    assert.match(text(tile("wlanpi.mode")), /^Mode Classic\s*CLS$/, "no status word for info");
    assert.match(text(tile("wlanpi.profiler")), /Off$/);
    // unknown: value drawn as an em dash
    assert.equal(tile("wlanpi.internet").querySelector(".menu-sb-value").textContent, "—");
    assert.match(tile("plugin.acme.uplink").getAttribute("title"), /WAN2, 14 ms/);
    // The compact form for phones sits beside the full value; unknown has none.
    assert.equal(tile("wlanpi.mode").querySelector(".menu-sb-short").textContent, "CLS");
    assert.equal(tile("wlanpi.ip").querySelector(".menu-sb-short"), null);
    assert.equal(tile("wlanpi.internet").querySelector(".menu-sb-short"), null);
  });

  it("caps the bar at 12 and counts the rest into +N", () => {
    const live = [];
    for (let i = 0; i < 15; i++) live.push({ app_id: `local.wlanpi.t${String(i).padStart(2, "0")}`, label: `T${i}`, value: String(i), status: "info" });
    const c = bootTiles({ live, config: config({ webui: { show: ["local.*"], source: "user" } }) });
    assert.equal(barTiles(c).length, Pages.BAR_MAX);
    const more = c.$("#menu-statusbar .menu-sb-more");
    assert.equal(more.hidden, false);
    assert.match(text(more), /^\+3 more on Home$/);
  });

  it("follows an edit made elsewhere without reconnecting", () => {
    const c = bootTiles();
    c.ws.receive(config({ webui: { show: ["local.*", "wlanpi.ip"], source: "user" } }, 2, {}));
    assert.deepEqual(barTiles(c), ["local.wlanpi.vpn", "wlanpi.ip"]);
    c.ws.receive(H.event("complications.live", 2, LIVE.filter((t) => t.app_id !== "local.wlanpi.vpn")));
    assert.deepEqual(barTiles(c), ["wlanpi.ip"], "an expired tile closes up");
  });

  it("keeps the old bar until the config and live set have both arrived", () => {
    const c = boot({ welcome: FEATURES });
    assert.equal(c.$("#menu-statusbar .menu-sb-tile"), null);
    assert.ok(c.$('#menu-statusbar [data-field="mode"]'));
  });

  it("shows only the core-down notice while device services are down", () => {
    const c = bootTiles();
    c.ws.receive(H.summaryEvent(2, { ...H.SUMMARY, core: "unavailable" }, {}));
    assert.equal(c.$("#menu-statusbar .menu-sb-tile"), null);
    assert.ok(c.$('#menu-statusbar [data-field="core"]'));
    assert.equal(c.$(".menu-tiles"), null);
  });

  it("cuts tiles from the end when the bar is too narrow, never reorders", () => {
    const c = bootTiles();
    const main = c.$("#menu-statusbar .menu-sb-tiles");
    const tiles = c.$$("#menu-statusbar .menu-sb-tile");
    // Fake layout: 100 px of room, every visible tile 30 px wide.
    Object.defineProperty(main, "clientWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(main, "scrollWidth", { configurable: true, get: () => tiles.filter((t) => !t.hidden).length * 30 });
    Pages.fitStatusBar(c.$("#menu-statusbar"));
    assert.deepEqual(tiles.filter((t) => !t.hidden).map((t) => t.getAttribute("data-field")), ["wlanpi.mode", "wlanpi.ip", "wlanpi.internet"]);
    assert.match(text(c.$("#menu-statusbar .menu-sb-more")), /^\+5 more on Home$/);
  });
});

describe("tiles: Home card", () => {
  it("lists every resolved tile with its status word, beside the device card", () => {
    const c = bootTiles();
    assert.ok(c.$(".menu-device"), "the device card stays");
    assert.equal(c.$(".menu-complications"), null, "the legacy list is replaced");
    const tiles = c.$$(".menu-tiles .menu-tile");
    assert.deepEqual(tiles.map((t) => t.getAttribute("data-tile")), barTiles(c));
    const byId = (id) => c.$(`.menu-tiles [data-tile="${id}"]`);
    assert.match(text(byId("wlanpi.battery")), /Batt\s*15%\s*Warning/);
    assert.match(text(byId("wlanpi.cpu_temp")), /Error/);
    assert.match(text(byId("wlanpi.internet")), /—\s*No reading/);
    assert.match(text(byId("plugin.acme.uplink")), /WAN2, 14 ms/);
    assert.equal(byId("wlanpi.mode").querySelector(".menu-tile-tag"), null, "info has no tag");
    assert.equal(c.$(".menu-tiles-customize").getAttribute("href"), "#/tiles");
  });

  it("inserts tile text as text, never as markup", () => {
    const evil = "<img src=x>";
    const c = bootTiles({ live: [{ app_id: "local.wlanpi.x", label: "<b>X</b>", value: evil, status: "ok", detail: "[red]x" }] });
    assert.equal(c.panel.querySelector("img"), null);
    assert.equal(c.panel.querySelector(".menu-tiles b"), null);
    assert.equal(c.$('.menu-tiles [data-tile="local.wlanpi.x"] .menu-tile-value').textContent, evil);
    assert.equal(c.$('#menu-statusbar [data-field="local.wlanpi.x"] .menu-sb-value').textContent, evil);
  });
});

describe("tiles: customize page (#/tiles)", () => {
  it("is a client page that cannot collide with a node id", () => {
    assert.equal(Router.hrefFor(Router.TILES_ID), "#/tiles");
    assert.equal(Router.resolve({ menu: { byId: {} } }, "#/tiles").type, Router.TYPE.TILES);
    const c = bootTiles();
    click(c.$(".menu-tiles-customize"));
    c.go("#/tiles");
    assert.equal(c.page().getAttribute("data-page"), "tiles");
    assert.match(text(c.$("#menu-page-title")), /Customize status tiles/);
  });

  it("offers all four profiles and lists shown tiles in order, then the available ones", () => {
    const c = bootTiles({ hash: "#/tiles" });
    const options = c.$$("#menu-tiles-surface option").map((o) => o.value);
    assert.deepEqual(options, ["webui", "panel", "panel.strip", "tui"]);
    assert.deepEqual(rowEntries(c, ".menu-tiles-shown"), WEBUI_SHOW);
    const shown = c.$(".menu-tiles-shown");
    assert.match(text(shown.querySelector('[data-entry="wlanpi.wifi"]')), /not reporting/);
    assert.match(text(shown.querySelector('[data-entry="plugin.*"]')), /All plugin tiles\s*1 tile reporting/);
    const avail = rowEntries(c, ".menu-tiles-available");
    assert.deepEqual(avail, ["local.wlanpi.vpn", "plugin.acme.idle", "plugin.acme.uplink", "wlanpi.cpu"]);
    assert.match(text(c.$('.menu-tiles-available [data-entry="plugin.acme.uplink"]')), /shown by All plugin tiles/);
    assert.match(text(c.$('.menu-tiles-available [data-entry="plugin.acme.idle"]')), /Acme idle\s*not reporting/);
    assert.match(text(c.$(".menu-tiles-source")), /default list/);
  });

  it("marks where the edited screen's capacity ends", () => {
    const c = bootTiles({ hash: "#/tiles" });
    c.$("#menu-tiles-surface").value = "panel.strip";
    c.$("#menu-tiles-surface").dispatchEvent(new c.window.Event("change", { bubbles: true }));
    const live = LIVE.concat([{ app_id: "wlanpi.bluetooth", label: "BT", value: "on", status: "ok" }]);
    c.ws.receive(H.event("complications.live", 2, live));
    c.ws.receive(config({ "panel.strip": { show: ["wlanpi.battery", "wlanpi.bluetooth", "wlanpi.internet", "wlanpi.mode", "wlanpi.ip"], source: "user" } }, 2, {}));
    const fit = c.$(".menu-tiles-fit");
    assert.ok(fit, "a fits-above marker");
    assert.match(fit.textContent, /Fits on the front panel status line above/);
    assert.equal(fit.previousElementSibling.getAttribute("data-entry"), "wlanpi.internet");
    assert.deepEqual(c.$$(".menu-tiles-row.is-over").map((e) => e.getAttribute("data-entry")), ["wlanpi.mode", "wlanpi.ip"]);
  });

  it("each edit sends one configure for the edited profile and waits for the server", () => {
    const c = bootTiles({ hash: "#/tiles" });
    click(c.$('.menu-tiles-shown [data-entry="wlanpi.ip"] [data-menu-action="tile-up"]'));
    const sent = configures(c);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].surface, "webui");
    assert.deepEqual(sent[0].show.slice(0, 2), ["wlanpi.ip", "wlanpi.mode"]);
    // Not optimistic: the list is unchanged until the config event.
    assert.deepEqual(rowEntries(c, ".menu-tiles-shown").slice(0, 2), ["wlanpi.mode", "wlanpi.ip"]);
    assert.match(text(c.$(".menu-tiles-source")), /Saving/);
    // A second edit while one is in flight is ignored.
    click(c.$('.menu-tiles-shown [data-entry="wlanpi.mode"] [data-menu-action="tile-remove"]'));
    assert.equal(configures(c).length, 1);
    c.ws.receive(config({ webui: { show: sent[0].show, source: "user" } }, 2, { id: sent[0].id, snapshot: true }));
    assert.deepEqual(rowEntries(c, ".menu-tiles-shown").slice(0, 2), ["wlanpi.ip", "wlanpi.mode"]);
    assert.doesNotMatch(text(c.$(".menu-tiles-source")), /Saving/);
    assert.match(text(c.$(".menu-tiles-source")), /Customized/);
    assert.deepEqual(barTiles(c).slice(0, 2), ["wlanpi.ip", "wlanpi.mode"], "the bar follows");
  });

  it("keeps keyboard focus on the moved tile's button", () => {
    const c = bootTiles({ hash: "#/tiles" });
    const btn = c.$('.menu-tiles-shown [data-entry="wlanpi.ip"] [data-menu-action="tile-up"]');
    btn.focus();
    click(btn);
    const sent = configures(c)[0];
    c.ws.receive(config({ webui: { show: sent.show, source: "user" } }, 2, { id: sent.id, snapshot: true }));
    const now = c.document.activeElement;
    assert.equal(now.getAttribute("data-focus-key"), "tile-up:wlanpi.ip");
    assert.equal(now.getAttribute("aria-disabled"), "true", "at the top: inert but still focusable");
    click(now);
    assert.equal(configures(c).length, 1, "an inert button sends nothing");
  });

  it("adds, removes and resets", () => {
    const c = bootTiles({ hash: "#/tiles" });
    click(c.$('.menu-tiles-available [data-entry="wlanpi.cpu"] [data-menu-action="tile-add"]'));
    let f = configures(c).pop();
    assert.deepEqual(f.show, WEBUI_SHOW.concat(["wlanpi.cpu"]));
    c.ws.receive(config({ webui: { show: f.show, source: "user" } }, 2, { id: f.id, snapshot: true }));
    click(c.$('.menu-tiles-shown [data-entry="local.*"] [data-menu-action="tile-remove"]'));
    f = configures(c).pop();
    assert.ok(!f.show.includes("local.*"));
    c.ws.receive(config({ webui: { show: f.show, source: "user" } }, 3, { id: f.id, snapshot: true }));
    assert.ok(rowEntries(c, ".menu-tiles-available").includes("local.*"), "a removed family can be added back");
    click(c.$('[data-menu-action="tiles-reset"]'));
    f = configures(c).pop();
    assert.deepEqual({ surface: f.surface, reset: f.reset, show: f.show }, { surface: "webui", reset: true, show: undefined });
  });

  it("edits the front panel's profile from the browser", () => {
    const c = bootTiles({ hash: "#/tiles" });
    const sel = c.$("#menu-tiles-surface");
    sel.value = "panel";
    sel.dispatchEvent(new c.window.Event("change", { bubbles: true }));
    assert.deepEqual(rowEntries(c, ".menu-tiles-shown").slice(0, 3), ["wlanpi.mode", "wlanpi.ip", "wlanpi.wifi"]);
    click(c.$('.menu-tiles-shown [data-entry="wlanpi.mode"] [data-menu-action="tile-down"]'));
    const f = configures(c).pop();
    assert.equal(f.surface, "panel");
    assert.deepEqual(f.show.slice(0, 2), ["wlanpi.ip", "wlanpi.mode"]);
  });

  it("shows a refusal and keeps the page usable", () => {
    const c = bootTiles({ hash: "#/tiles" });
    click(c.$('.menu-tiles-shown [data-entry="wlanpi.ip"] [data-menu-action="tile-up"]'));
    const f = configures(c).pop();
    c.ws.receive(H.assertS2C({ v: 1, type: "error", id: f.id, code: "FORBIDDEN", message: "role viewer may not configure" }));
    assert.match(text(c.$(".menu-tiles-error")), /not allowed/);
    assert.doesNotMatch(text(c.$(".menu-tiles-source")), /Saving/);
    click(c.$('.menu-tiles-shown [data-entry="wlanpi.ip"] [data-menu-action="tile-up"]'));
    assert.equal(configures(c).length, 2);
  });

  it("is read-only for a viewer", () => {
    const c = bootTiles({ hash: "#/tiles", welcome: { roles: ["viewer"] } });
    assert.match(text(c.page()), /can view these tiles but not change them/);
    const buttons = c.$$('.menu-tiles-row [data-menu-action]');
    assert.ok(buttons.length > 0 && buttons.every((b) => b.disabled));
    click(buttons[0]);
    assert.equal(configures(c).length, 0);
  });

  it("names no protocol shape in its copy", () => {
    const c = bootTiles({ hash: "#/tiles" });
    assert.doesNotMatch(text(c.page()), /\b(rich|thin|mirror|session)\b/i);
  });
});

describe("tiles: the Front panel pane is unaffected", () => {
  it("the pane sends only its own hello and input, never tile frames", () => {
    const c = bootTiles();
    click(c.$("#menu-panel-toggle"));
    const ws = c.paneWs;
    ws.open();
    ws.receive(H.assertS2C({ ...H.sample("s2c", "welcome.default.json"), ...FEATURES }));
    const types = paneSockets(c.WS).flatMap((s) => s.sent.map((f) => f.type));
    assert.ok(types.every((t) => t === "hello" || t === "input"), types.join(","));
  });
});

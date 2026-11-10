import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as H from "./helpers/harness.mjs";
import { boot, MemoryStorage, paneSockets, menuSockets } from "./helpers/app.mjs";

const FrontPanel = H.load("menu/front_panel.js");
const { click, text, key } = H;

const view = (name, extra = {}) => H.assertS2C({ ...H.sample("s2c", name), ...extra });
const thinWelcome = (extra = {}) => H.assertS2C({ ...H.sample("s2c", "welcome.default.json"), ...extra });

function openPane(o = {}) {
  const c = boot(o);
  if (!o.search) click(c.$("#menu-panel-toggle"));
  const ws = c.paneWs;
  ws.open();
  ws.receive(thinWelcome());
  return c;
}

describe("Front panel: the second connection", () => {
  it("does not exist until the pane opens, and closes with it", () => {
    const c = boot();
    assert.equal(c.WS.sockets.length, 1, "only the menu connection");
    assert.equal(c.$("#menu-front-panel").hidden, true);
    assert.equal(c.$("#menu-panel-toggle").getAttribute("aria-pressed"), "false");

    click(c.$("#menu-panel-toggle"));
    assert.equal(c.WS.sockets.length, 2, "toggling opens a second socket");
    assert.equal(c.$("#menu-front-panel").hidden, false);
    assert.equal(c.$("#menu-panel-toggle").getAttribute("aria-pressed"), "true");
    assert.ok(c.panel.classList.contains("has-pane"));
    const paneWs = c.paneWs;
    paneWs.open();
    const hello = paneWs.sent[0];
    assert.equal(hello.mode, "thin");
    assert.equal(hello.session, "default");
    assert.equal(hello.client.name, "wlanpi-webui-front-panel");
    assert.deepEqual(hello.capabilities.blocks.slice().sort(), ["confirm", "kv", "list", "progress", "qr", "status", "table", "text"]);

    const menuWs = c.ws;
    click(c.$('[data-fp-action="close"]'));
    assert.deepEqual(paneWs.closed, { code: 1000, reason: "client closed", byClient: true });
    assert.equal(menuWs.closed, null, "closing the pane detaches only the pane");
    assert.equal(c.app.getConnectionState().phase, "live");
    assert.equal(c.$("#menu-front-panel").hidden, true);
    assert.equal(c.app.connections().frontPanel, null);
    assert.equal(c.$("#menu-panel-toggle").getAttribute("aria-pressed"), "false");
  });

  it("the pane and the menu work at the same time", () => {
    const c = openPane({ hash: "#net.ifaces" });
    c.paneWs.receive(view("view.menu.json"));
    c.finish("net.ifaces", [H.tableBlock(H.rowsFrom(0, 3))]);
    assert.equal(c.$("#menu-result").querySelectorAll("tbody tr").length, 3);
    assert.ok(c.$(".menu-fp-screen .block-list"));
    click(c.$('[data-fp-key="down"]'));
    click(c.$('[data-menu-action="refresh"]'));
    assert.equal(c.invokes().length, 2);
    assert.deepEqual(c.paneWs.ofType("input").map((f) => f.key), ["down"]);
    // The pane sends only hello and input; the menu connection never sends input.
    assert.deepEqual([...new Set(c.paneWs.sent.map((f) => f.type))].sort(), ["hello", "input"]);
    assert.equal(menuSockets(c.WS).some((ws) => ws.sent.some((f) => f.type === "input" || f.type === "nav")), false);
  });

  it("remembers the choice per browser and reopens on the next load", () => {
    const storage = new MemoryStorage();
    const c = boot({ storage });
    click(c.$("#menu-panel-toggle"));
    assert.equal(storage.getItem(FrontPanel.PREF_KEY), "1");
    click(c.$("#menu-panel-toggle"));
    assert.equal(storage.getItem(FrontPanel.PREF_KEY), "0");

    const again = boot({ storage: new MemoryStorage({ [FrontPanel.PREF_KEY]: "1" }) });
    assert.equal(again.WS.sockets.length, 2, "open on load");
    assert.equal(again.$("#menu-front-panel").hidden, false);
    const off = boot({ storage: new MemoryStorage() });
    assert.equal(off.WS.sockets.length, 1, "off by default");
  });

  it("?panel=private binds the pane to its own screen as 'Panel preview'", () => {
    const c = openPane({ search: "?panel=private" });
    const hello = c.paneWs.sent[0];
    assert.equal(hello.mode, "thin");
    assert.equal(hello.session, "new");
    assert.match(text(c.$("#menu-fp-title")), /^Panel preview/);
    assert.equal(text(c.$("#menu-panel-toggle")), "Panel preview");
    assert.equal(c.$(".menu-fp-notice"), null, "no shared-screen notice");
    c.paneWs.receive(view("view.mirror.json"));
    assert.equal(c.$('[data-region="driven"]').hidden, true, "no driving line");
    // The flag is not remembered as the user's choice.
    assert.equal(c.storage.getItem(FrontPanel.PREF_KEY), null);
    assert.deepEqual(FrontPanel.helloFor(false).session, "default");
  });
});

describe("Front panel: screen", () => {
  it("renders the view with the shared block renderers: title, breadcrumb, blocks, selected row", () => {
    const c = openPane();
    const v = view("view.mirror.json");
    c.paneWs.receive(v);
    const screen = c.$(".menu-fp-screen");
    assert.equal(text(screen.querySelector(".menu-fp-screen-title")), v.title);
    const list = v.blocks.find((b) => b.type === "list");
    const items = screen.querySelectorAll(".list-item");
    assert.equal(items.length, list.items.length);
    const selected = screen.querySelectorAll(".list-item-selected");
    assert.equal(selected.length, 1);
    assert.equal(selected[0].getAttribute("data-index"), String(list.selected));
    assert.equal(screen.querySelector("a"), null, "rows on the device screen are not page links");
    assert.equal(screen.getAttribute("tabindex"), "0", "the screen is focusable");
    assert.match(screen.getAttribute("aria-label"), /Arrow keys/);
  });

  it("shows the page position when the view sends one", () => {
    const c = openPane();
    c.paneWs.receive(view("view.menu.json", { page: { index: 1, count: 7, more: true } }));
    assert.equal(text(c.$(".menu-fp-pagepos")), "2 / 7");
    const single = view("view.menu.json");
    delete single.page;
    c.paneWs.receive(single);
    assert.equal(c.$(".menu-fp-pagepos"), null);
  });

  it("renders unknown block types from their text fallback", () => {
    const c = openPane();
    const v = view("view.home.json");
    c.paneWs.receive({ ...v, blocks: [{ type: "hologram", text: "plain fallback" }] });
    assert.match(text(c.$(".menu-fp-screen")), /plain fallback/);
  });

  it("shows the first-open notice once", () => {
    const storage = new MemoryStorage();
    const c = openPane({ storage });
    assert.match(text(c.$(".menu-fp-notice")), /Buttons here move the device's own screen\. Anyone looking at the device sees the same thing\./);
    click(c.$('[data-fp-action="notice-ok"]'));
    assert.equal(c.$(".menu-fp-notice"), null);
    assert.equal(storage.getItem(FrontPanel.NOTICE_KEY), "1");
    const again = openPane({ storage: new MemoryStorage({ [FrontPanel.NOTICE_KEY]: "1" }) });
    assert.equal(again.$(".menu-fp-notice"), null);
  });
});

describe("Front panel: who is driving", () => {
  it("is hidden until someone has driven", () => {
    const c = openPane();
    const v = view("view.home.json");
    delete v.driven_by;
    c.paneWs.receive(v);
    assert.equal(c.$('[data-region="driven"]').hidden, true);
  });

  it("says 'You are driving' for this connection's own input", () => {
    const c = openPane();
    c.paneWs.receive(view("view.menu.json", { driven_by: { principal: { kind: "webui", name: "alice" }, surface: "wlanpi-webui-front-panel", self: true } }));
    assert.equal(text(c.$('[data-region="driven"]')), "You are driving");
    assert.equal(c.$('[data-region="driven"]').hidden, false);
  });

  it("names the surface and principal when someone else drives", () => {
    const c = openPane();
    c.paneWs.receive(view("view.menu.json", { driven_by: { principal: { kind: "local", name: "wlanpi", uid: 1000 }, surface: "wlanpi-menu-tui", self: false } }));
    assert.equal(text(c.$('[data-region="driven"]')), "Driven from wlanpi-menu-tui (wlanpi)");
    assert.equal(FrontPanel.drivenText({ driven_by: { principal: { kind: "local", name: "x" }, self: false } }), "Driven from another surface (x)");
    assert.equal(FrontPanel.drivenText({}), "");
  });
});

describe("Front panel: keys", () => {
  it("builds the keys from the view's hints; the client holds no key meanings", () => {
    const c = openPane();
    c.paneWs.receive(view("view.menu.json", { hints: { left: "Back", center: "Select" } }));
    const keys = c.$$("[data-fp-key]");
    assert.deepEqual(keys.map((b) => b.getAttribute("data-fp-key")), ["up", "left", "center", "right", "down"]);
    const caption = (k) => { const e = c.$(`[data-fp-key="${k}"] .menu-fp-key-caption`); return e ? e.textContent : null; };
    assert.equal(caption("left"), "Back");
    assert.equal(caption("center"), "Select");
    assert.equal(caption("up"), null);
    assert.equal(c.$('[data-fp-key="left"]').getAttribute("aria-label"), "Left Back");
    assert.equal(c.$('[data-fp-key="up"]').getAttribute("aria-label"), "Up");

    c.paneWs.receive(view("view.menu.json", { hints: { left: "Leave", center: "Again", key1: "Rescan", key3: "Save" } }));
    assert.equal(caption("left"), "Leave", "captions follow the server");
    assert.deepEqual(c.$$("[data-fp-key]").map((b) => b.getAttribute("data-fp-key")), ["up", "left", "center", "right", "down", "key1", "key3"],
      "Key 1 to Key 3 appear only when the hints name them");
    assert.equal(c.$('[data-fp-key="key1"]').getAttribute("aria-label"), "Key 1 Rescan");
  });

  it("buttons send input frames", () => {
    const c = openPane();
    c.paneWs.receive(view("view.menu.json", { hints: { left: "Back", center: "Select", key2: "Other" } }));
    for (const k of ["up", "down", "left", "right", "center", "key2"]) click(c.$(`[data-fp-key="${k}"]`));
    assert.deepEqual(c.paneWs.ofType("input").map((f) => f.key), ["up", "down", "left", "right", "center", "key2"]);
    assert.equal(c.sent("input").length, 0, "nothing on the menu connection");
  });

  it("arrow keys, Enter and Backspace are captured only while focus is inside the pane", () => {
    const c = openPane({ hash: "#net" });
    c.paneWs.receive(view("view.menu.json"));
    // Outside the pane: the page keeps its keyboard.
    for (const target of [c.document.body, c.$("#menu-page-title"), c.$('.menu-row'), c.$("#menu-filter")]) {
      for (const k of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Backspace"]) {
        const evt = key(target, k);
        assert.equal(evt.defaultPrevented, false, `${k} outside the pane is left alone`);
      }
    }
    assert.equal(c.paneWs.ofType("input").length, 0);

    const screen = c.$(".menu-fp-screen");
    screen.focus();
    const sent = [];
    for (const k of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Backspace"]) {
      const evt = key(screen, k);
      assert.equal(evt.defaultPrevented, true, `${k} inside the pane is captured`);
      sent.push(k);
    }
    assert.deepEqual(c.paneWs.ofType("input").map((f) => f.key), ["up", "down", "left", "right", "center", "left"]);
    assert.deepEqual(FrontPanel.KEYBOARD, { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "center", Backspace: "left" });

    // Enter on one of the pane's own buttons is that button, not also OK.
    const before = c.paneWs.ofType("input").length;
    const evt = key(c.$('[data-fp-key="down"]'), "Enter");
    assert.equal(evt.defaultPrevented, false);
    assert.equal(c.paneWs.ofType("input").length, before);
    // Modified keys are the browser's.
    key(screen, "ArrowLeft", { altKey: true });
    assert.equal(c.paneWs.ofType("input").length, before);
  });
});

describe("Front panel: shared prompts", () => {
  it("shows a prompt as screen content, never as a dialog", () => {
    const c = openPane();
    c.paneWs.receive(H.assertS2C({ ...H.sample("s2c", "prompt.confirm.json") }));
    c.paneWs.receive(view("view.prompt-not-answerable.json"));
    assert.equal(c.$('[role="dialog"]'), null, "prompt frames on the pane connection are not dialogs");
    const screen = c.$(".menu-fp-screen");
    assert.equal(screen.getAttribute("data-screen"), "prompt");
    assert.match(text(screen), /Reboot the WLAN Pi now\?/);
    assert.equal(screen.querySelector("button"), null, "the confirm block is screen text here");
    assert.equal(text(screen.querySelector(".confirm-choice-selected")), "Cancel");
  });

  it("answerable: false disables the keys and says who it is waiting for", () => {
    const c = openPane();
    const v = view("view.prompt-not-answerable.json");
    c.paneWs.receive(H.assertS2C({
      v: 1, type: "prompt", id: "s:41", prompt_id: "p91c3", job_id: v.job_id, node: v.node, kind: "confirm", title: "Reboot",
      message: "Reboot the WLAN Pi now?", invoked_by: { kind: "local", name: "wlanpi", uid: 1000 },
    }));
    c.paneWs.receive(v);
    assert.equal(c.$$("[data-fp-key]").every((b) => b.disabled), true);
    assert.equal(text(c.$('[data-region="waiting"]')), "Waiting for wlanpi to confirm on the device.");
    assert.equal(c.$('[data-region="waiting"]').hidden, false);
    assert.match(text(c.$(".menu-fp-keys-off")), /Keys disabled/);
    click(c.$('[data-fp-key="center"]'));
    c.$(".menu-fp-screen").focus();
    key(c.$(".menu-fp-screen"), "Enter");
    assert.equal(c.paneWs.ofType("input").length, 0, "nothing is sent while another principal's confirmation is up");

    c.paneWs.receive(view("view.menu.json"));
    assert.equal(c.$$("[data-fp-key]").every((b) => !b.disabled), true);
    assert.equal(c.$('[data-region="waiting"]').hidden, true);
  });
});

describe("Front panel: its own connection state", () => {
  it("a pane failure stays in the pane and leaves the menu connection untouched", () => {
    const c = openPane({ hash: "#net.ifaces" });
    c.finish("net.ifaces", [H.tableBlock(H.rowsFrom(0, 3))]);
    c.paneWs.receive(view("view.menu.json"));
    const menuWs = c.ws;
    c.paneWs.serverClose(1006);

    assert.equal(c.app.getConnectionState().phase, "live");
    assert.equal(c.ws, menuWs);
    assert.equal(menuWs.closed, null);
    assert.equal(c.$("#menu-banner").hidden, true, "no page banner for a pane failure");
    assert.equal(c.panel.classList.contains("is-stale"), false);
    assert.equal(c.$('[data-menu-action="refresh"]').disabled, false);

    const pane = c.$("#menu-front-panel");
    assert.match(text(pane.querySelector(".menu-fp-conn")), /^Connection lost\. Retrying in 1 s\.\s*Retry now$/);
    assert.match(text(pane.querySelector(".menu-fp-indicator")), /offline/);
    assert.ok(pane.querySelector(".menu-fp-screen").classList.contains("is-stale"), "the last screen stays, dimmed");
    assert.ok(pane.querySelector(".menu-fp-screen .block-list"));
    assert.equal(c.$$("[data-fp-key]").every((b) => b.disabled), true);

    const n = paneSockets(c.WS).length;
    click(pane.querySelector('[data-fp-action="retry"]'));
    c.paneWs.open();
    assert.equal(paneSockets(c.WS).length, n + 1);
    assert.equal(c.paneWs.sent[0].resume.epoch, thinWelcome().epoch, "the pane resumes too");
    c.paneWs.receive(thinWelcome({ resumed: true }));
    c.paneWs.receive(view("view.menu.json"));
    assert.match(text(pane.querySelector(".menu-fp-indicator")), /live/);
    assert.equal(pane.querySelector(".menu-fp-conn"), null);
    assert.equal(c.invokes().length, 1, "the menu did nothing");
  });

  it("logout (4401) closes both: the page and the pane each show signed out", () => {
    const c = openPane({ hash: "#net" });
    c.paneWs.receive(view("view.menu.json"));
    c.ws.serverClose(4401);
    c.app.connections().frontPanel.ws.serverClose(4401);
    assert.match(text(c.$("#menu-banner")), /You have been signed out\./);
    assert.match(text(c.$(".menu-fp-conn")), /You have been signed out\./);
    const n = c.WS.sockets.length;
    c.timers.advance(600000);
    assert.equal(c.WS.sockets.length, n, "neither reconnects");
  });

  it("a menu failure does not close the pane", () => {
    const c = openPane();
    c.paneWs.receive(view("view.menu.json"));
    const paneWs = c.paneWs;
    c.ws.serverClose(1006);
    assert.equal(paneWs.closed, null);
    assert.match(text(c.$(".menu-fp-indicator")), /live/);
    click(c.$('[data-fp-key="down"]'));
    assert.equal(paneWs.ofType("input").length, 1);
  });
});

describe("Front panel: sheet", () => {
  it("collapses to a title bar showing the screen title, and expands again", () => {
    const c = openPane();
    c.paneWs.receive(view("view.menu.json"));
    const title = view("view.menu.json").title;
    const btn = c.$('[data-fp-action="collapse"]');
    assert.equal(btn.getAttribute("aria-expanded"), "true");
    click(btn);
    const pane = c.$("#menu-front-panel");
    assert.ok(pane.classList.contains("is-collapsed"));
    assert.ok(c.panel.classList.contains("has-pane-collapsed"), "the page pads for the collapsed sheet");
    assert.equal(btn.getAttribute("aria-expanded"), "false");
    assert.equal(text(c.$("#menu-fp-title")), "Front panel · " + title);
    click(btn);
    assert.equal(pane.classList.contains("is-collapsed"), false);
    assert.equal(c.panel.classList.contains("has-pane-collapsed"), false);
    assert.equal(text(c.$("#menu-fp-title")), "Front panel");
  });
});

// The menu page on jsdom, one block per wireframe in
// wlanpi-menud docs/webui-menu-redesign.md (4.1 to 4.8, 4.13 to 4.17).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as H from "./helpers/harness.mjs";
import { boot, menuSockets, MemoryStorage, Main } from "./helpers/app.mjs";

const Pages = H.load("menu/pages.js");
const { click, text, job, tableBlock, rowsFrom } = H;

const BANNED = /\b(rich|thin|mirror|session)\b/i;

describe("4.1 Home", () => {
  it("has no mode control and names no protocol shape", () => {
    const c = boot();
    assert.equal(c.$("select"), null, "no select anywhere on Home");
    assert.equal(c.$("#menu-mode-select"), null);
    assert.equal(c.$('input[type="checkbox"]'), null);
    assert.doesNotMatch(text(c.panel), BANNED);
  });

  it("status bar shows host, mode, IP, temperature, battery and the alert count", () => {
    const c = boot({ alerts: [{ level: "warn", message: "Time not synchronised" }] });
    const bar = c.$("#menu-statusbar");
    assert.equal(bar.tagName, "A");
    assert.equal(bar.getAttribute("href"), "#", "selecting it goes Home");
    const fields = Array.from(bar.querySelectorAll(".menu-sb-item")).map((e) => e.textContent);
    assert.deepEqual(fields, ["wlanpi-a1b2", "Classic", "192.168.1.42", "48 °C", "Battery 87 % charging"]);
    assert.match(text(bar.querySelector(".menu-sb-alerts")), /1 alert$/);
    assert.ok(bar.querySelector(".menu-sb-alerts [uk-icon]"), "the alert count carries an icon, not colour alone");
  });

  it("omits null fields instead of showing dashes", () => {
    const c = boot({ summary: { hostname: "wlanpi-x", mode: null, ip: null, cpu_temp: null, battery: { present: false } } });
    const fields = c.$$("#menu-statusbar .menu-sb-item").map((e) => e.textContent);
    assert.deepEqual(fields, ["wlanpi-x"]);
    assert.doesNotMatch(text(c.$("#menu-statusbar")), /—|null|undefined/);
    assert.equal(c.$(".menu-sb-alerts"), null, "no alert count at zero");
  });

  it("device card lists the summary fields; alerts and complications follow", () => {
    const c = boot({
      alerts: [{ level: "warn", message: "Time not synchronised" }, { level: "error", message: "Disk full" }],
      complications: [{ app_id: "acme", label: "Acme", value: "3 clients", status: "ok" }],
    });
    const card = c.$(".menu-device");
    const pairs = Object.fromEntries(Array.from(card.querySelectorAll(".menu-device-field")).map((f) => [
      f.querySelector("dt").textContent, f.querySelector("dd").textContent,
    ]));
    assert.deepEqual(pairs, {
      Hostname: "wlanpi-a1b2", Model: "WLAN Pi Pro", Mode: "Classic", Software: "3.4.0", IP: "192.168.1.42",
      Uptime: "2 d 4 h", eth0: "192.168.1.42", CPU: "3 %", Temperature: "48 °C", Battery: "87 % charging",
      Bluetooth: "off", Profiler: "stopped", Internet: "reachable", "WLAN adapters": "wlan0, wlan1",
    });
    assert.ok(!("wlan0" in pairs), "wlan0 is null in the summary: omitted");
    const alerts = c.$$(".menu-alert");
    assert.equal(alerts.length, 2);
    assert.match(text(alerts[0]), /^Warning Time not synchronised$/);
    assert.match(text(alerts[1]), /^Error Disk full$/);
    assert.equal(alerts[1].getAttribute("data-level"), "error");
    assert.match(text(c.$(".menu-complications")), /Acme\s*3 clients\s*ok/);
  });

  it("section cards come from the menu frame: label, child count, link", () => {
    const c = boot();
    const cards = c.$$(".menu-card");
    assert.deepEqual(cards.map((a) => [a.getAttribute("href"), text(a.querySelector(".menu-card-label")), text(a.querySelector(".menu-card-sub"))]), [
      ["#net", "Net", "2 items"], ["#tools", "Tools", "6 items"], ["#sys", "Sys", "3 items"],
    ]);
    // The container is a real HTMLCollection: array methods are not there.
    const list = c.$(".menu-cards");
    assert.ok(list.children instanceof c.window.HTMLCollection);
    assert.equal(typeof list.children.indexOf, "undefined");
    assert.equal(list.children.length, 3);
  });

  it("sidebar is a nav landmark of real links with Home current", () => {
    const c = boot();
    const nav = c.$("#menu-sidebar");
    assert.equal(nav.tagName, "NAV");
    assert.ok(nav.getAttribute("aria-label"));
    const links = Array.from(nav.querySelectorAll("a"));
    assert.deepEqual(links.map((a) => [a.getAttribute("href"), a.textContent]), [["#", "Home"], ["#net", "Net"], ["#tools", "Tools"], ["#sys", "Sys"]]);
    assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
    assert.equal(nav.querySelector('[aria-current="page"]').textContent, "Home");
    assert.equal(c.invokes().length, 0, "Home runs nothing");
  });

  it("the filter narrows by label and '/' focuses it", () => {
    const c = boot();
    const input = c.$("#menu-filter");
    H.key(c.document.body, "/");
    assert.equal(c.document.activeElement, input);
    input.value = "cap";
    input.dispatchEvent(new c.window.Event("input", { bubbles: true }));
    const hits = Array.from(c.$("#menu-sidebar").querySelectorAll("a")).map((a) => a.getAttribute("href"));
    assert.deepEqual(hits, ["#tools.capture", "#tools.capture.more"]);
    assert.deepEqual(c.$$("#menu-page .menu-row").map((a) => a.getAttribute("href")), ["#tools.capture", "#tools.capture.more"]);
    assert.equal(c.document.activeElement, input, "typing keeps focus in the filter");
    assert.equal(input.value, "cap");
    input.value = "zzz";
    input.dispatchEvent(new c.window.Event("input", { bubbles: true }));
    assert.match(text(c.$("#menu-sidebar")), /No menu items match/);
    // '/' typed into a field is just a character.
    const evt = H.key(input, "/");
    assert.equal(evt.defaultPrevented, false);
  });
});

describe("4.2 Branch page", () => {
  it("lists children as links with a cue for what selecting each will do", () => {
    const c = boot({ hash: "#tools" });
    assert.equal(text(c.$("#menu-page-title")), "Tools");
    assert.equal(c.$("#menu-page-title").tagName, "H2");
    const rows = c.$$("#menu-page .menu-row");
    const cue = (id) => {
      const r = rows.find((a) => a.getAttribute("data-node") === id);
      return { name: text(r.querySelector(".menu-row-name")), cues: text(r.querySelector(".menu-row-cues")), href: r.getAttribute("href") };
    };
    assert.deepEqual(rows.map((r) => r.getAttribute("data-node")),
      ["tools.survey", "tools.speed", "tools.radio_on", "tools.legacy", "tools.plugin", "tools.capture"]);
    assert.deepEqual(cue("tools.survey"), { name: "Survey…", cues: "", href: "#tools.survey" });
    assert.deepEqual(cue("tools.speed"), { name: "Speed", cues: "", href: "#tools.speed" });
    assert.deepEqual(cue("tools.radio_on"), { name: "Radio On", cues: "changes device", href: "#tools.radio_on" });
    assert.deepEqual(cue("tools.legacy"), { name: "Legacy Thing", cues: "changes device", href: "#tools.legacy" },
      "a node without `mutates` is treated as mutating");
    assert.deepEqual(cue("tools.plugin"), { name: "Plugin Thing", cues: "acme", href: "#tools.plugin" });
    assert.deepEqual(cue("tools.capture"), { name: "Capture", cues: "1 item", href: "#tools.capture" });
    const marker = rows[2].querySelector(".menu-row-mutates");
    assert.ok(marker.querySelector("[uk-icon]"), "marker is an icon plus text");
    assert.equal(c.invokes().length, 0, "a branch page runs nothing");
  });

  it("breadcrumb links every ancestor; the sidebar expands and marks the path", () => {
    const c = boot({ hash: "#tools.capture.more" });
    const crumbs = c.$$(".menu-crumbs-full li");
    assert.deepEqual(crumbs.map((li) => [text(li), li.querySelector("a") ? li.querySelector("a").getAttribute("href") : null]), [
      ["Menu", "#"], ["Tools", "#tools"], ["Capture", "#tools.capture"], ["More Capture", null],
    ]);
    assert.equal(c.$(".menu-back").getAttribute("href"), "#tools.capture");
    assert.match(text(c.$(".menu-back")), /Capture$/);
    const current = c.$('#menu-sidebar [aria-current="page"]');
    assert.equal(current.getAttribute("href"), "#tools.capture.more");
    assert.ok(c.$('#menu-sidebar a[href="#tools.capture"]'), "the path is expanded");
    assert.equal(c.$('#menu-sidebar a[href="#net.ifaces"]'), null, "other sections stay collapsed");
  });

  it("an empty branch says so", () => {
    const c = boot({ hash: "#sys.empty" });
    assert.match(text(c.page()), /Nothing here\./);
  });

  it("moving focus to the page title on navigation", () => {
    const c = boot();
    c.go("#net");
    assert.equal(c.document.activeElement, c.$("#menu-page-title"));
    assert.equal(c.$("#menu-page-title").getAttribute("tabindex"), "-1");
    c.go("#net.ifaces");
    assert.equal(c.document.activeElement, c.$("#menu-page-title"));
    assert.equal(text(c.document.activeElement), "Ifaces");
  });
});

describe("4.3 Read-only action runs on arrival", () => {
  it("sends exactly one invoke on arrival and renders the result on the page", () => {
    const c = boot({ hash: "#net.ifaces" });
    assert.equal(c.invokes().length, 1);
    const inv = c.invokes()[0];
    assert.deepEqual(Object.keys(inv).sort(), ["id", "node", "type", "v"], "no params, not confirmed");
    assert.equal(inv.node, "net.ifaces");
    const region = c.$("#menu-result");
    assert.equal(region.getAttribute("aria-busy"), "true");
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 3))]);
    assert.equal(region.getAttribute("aria-busy"), "false");
    assert.equal(region.querySelectorAll("tbody tr").length, 3);
    assert.match(text(c.$(".menu-updated")), /^Updated \d\d:\d\d:\d\d$/);
    assert.equal(c.$$("#menu-page #menu-result").length, 1, "one result region");
    assert.doesNotMatch(text(c.page()), /No actions run yet/);
    assert.equal(c.$("#menu-action-form"), null, "no Run button on a read-only page");
    // Topic updates and re-renders are not arrivals.
    c.ws.receive(H.summaryEvent(2, { ...H.SUMMARY, cpu: "9%" }, {}));
    c.app.render();
    assert.equal(c.invokes().length, 1);
  });

  it("drilling from Home by links reaches it with one invoke and the hash as the node id", () => {
    const c = boot();
    c.go(c.$('.menu-card[data-node="net"]').getAttribute("href"));
    assert.equal(c.invokes().length, 0);
    c.go(c.$('.menu-row[data-node="net.ifaces"]').getAttribute("href"));
    assert.equal(c.window.location.hash, "#net.ifaces");
    assert.equal(c.invokes().length, 1);
  });

  it("Refresh re-runs in place; returning shows the last result at once and refreshes it", () => {
    const c = boot({ hash: "#net.ifaces" });
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 3))]);
    const refresh = c.$('[data-menu-action="refresh"]');
    assert.equal(refresh.disabled, false);
    click(refresh);
    assert.equal(c.invokes().length, 2);
    assert.equal(c.$('[data-menu-action="refresh"]').disabled, true, "disabled while the job is live");
    assert.equal(c.$("#menu-result").querySelectorAll("tbody tr").length, 3, "the previous result stays while refreshing");
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 4))], { job_id: "j002" });
    assert.equal(c.$("#menu-result").querySelectorAll("tbody tr").length, 4);

    c.go("#net");
    c.go("#net.ifaces");
    assert.equal(c.$("#menu-result").querySelectorAll("tbody tr").length, 4, "result memory: shown at once");
    assert.equal(c.invokes().length, 3, "and refreshed in place");
  });

  it("100 consecutive refreshes leave the result region's node count unchanged", () => {
    const c = boot({ hash: "#net.ifaces" });
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 5))]);
    const count = () => c.$("#menu-result").querySelectorAll("*").length;
    const before = count();
    for (let i = 0; i < 100; i++) {
      click(c.$('[data-menu-action="refresh"]'));
      c.finish("net.ifaces", [tableBlock(rowsFrom(0, 5))], { job_id: "j1" + String(i).padStart(3, "0") });
    }
    assert.equal(c.invokes().length, 101);
    assert.equal(count(), before);
    assert.equal(c.$$("#menu-result").length, 1);
    assert.equal(Object.keys(c.app.getState().results).length, 1);
  });

  it("a view frame on the menu connection is ignored", () => {
    const c = boot({ hash: "#net" });
    const before = c.panel.innerHTML;
    const sent = c.ws.sent.length;
    c.ws.receive(H.sample("s2c", "view.menu.json"));
    c.ws.receive(H.sample("s2c", "view.home.json"));
    assert.equal(c.panel.innerHTML, before);
    assert.equal(c.ws.sent.length, sent);
    assert.equal(c.$("#menu-front-panel").hidden, true);
  });

  it("the menu connection never sends nav or input", () => {
    const c = boot({ hash: "#net.ifaces" });
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 3))]);
    c.go("#tools");
    c.go("#");
    const types = new Set(menuSockets(c.WS).flatMap((ws) => ws.sent.map((f) => f.type)));
    assert.deepEqual([...types].sort(), ["hello", "invoke", "subscribe"]);
    const hello = c.sent("hello")[0];
    assert.equal(hello.mode, "rich");
    assert.equal(hello.session, "new");
    assert.deepEqual(c.sent("subscribe")[0].topics, ["device.summary", "alerts", "complications", "jobs"]);
  });
});

describe("4.4 Action with parameters, idle", () => {
  it("shows the form and waits: nothing is sent on arrival", () => {
    const c = boot({ hash: "#tools.survey" });
    assert.equal(c.invokes().length, 0);
    const form = c.$("#menu-action-form");
    assert.ok(form);
    const select = form.querySelector('[data-param="adapter"]');
    assert.equal(select.tagName, "SELECT");
    assert.deepEqual(Array.from(select.options).map((o) => o.textContent), ["Automatic", "wlan0", "wlan1"],
      "adapter choices come from device.summary");
    assert.equal(form.querySelector("label").getAttribute("for"), select.id);
    assert.equal(text(form.querySelector('[data-menu-action="run"]')), "Run");
    assert.match(text(c.$(".menu-idle")), /select Run/);
    assert.equal(c.$(".menu-mutates"), null, "a read-only form page is not marked as changing the device");
  });

  it("Run sends one invoke with the chosen parameters", () => {
    const c = boot({ hash: "#tools.survey" });
    c.$('[data-param="adapter"]').value = "wlan1";
    click(c.$('[data-menu-action="run"]'));
    assert.equal(c.invokes().length, 1);
    assert.deepEqual(c.invokes()[0].params, { adapter: { iface: "wlan1" } });
    assert.equal(c.invokes()[0].confirmed, undefined);
  });

  it("an optional parameter left empty is not sent", () => {
    const c = boot({ hash: "#tools.survey" });
    click(c.$('[data-menu-action="run"]'));
    assert.equal(c.invokes().length, 1);
    assert.equal(c.invokes()[0].params, undefined);
  });

  it("builds enum, integer and string controls from the schema's params, with native validation", () => {
    const c = boot({ hash: "#sys.region" });
    const form = c.$("#menu-action-form");
    const country = form.querySelector('[data-param="country"]');
    const power = form.querySelector('[data-param="power"]');
    const note = form.querySelector('[data-param="note"]');
    assert.equal(country.required, true);
    assert.deepEqual(Array.from(country.options).map((o) => o.textContent), ["Choose…", "US", "CZ"]);
    assert.equal(power.type, "number");
    assert.equal(power.getAttribute("min"), "1");
    assert.equal(power.getAttribute("max"), "30");
    assert.equal(power.value, "20");
    assert.equal(note.getAttribute("maxlength"), "16");

    click(form.querySelector('[data-menu-action="run"]'));
    assert.equal(c.invokes().length, 0, "a missing required value sends nothing");

    country.value = "1";
    power.value = "99";
    click(form.querySelector('[data-menu-action="run"]'));
    assert.equal(c.invokes().length, 0, "out of range sends nothing");

    power.value = "12";
    note.value = "hello";
    click(form.querySelector('[data-menu-action="run"]'));
    assert.equal(c.invokes().length, 1);
    assert.deepEqual(c.invokes()[0].params, { country: "CZ", power: 12, note: "hello" });
  });

  it("keeps what the user typed when unrelated state changes", () => {
    const c = boot({ hash: "#sys.region" });
    const note = c.$('[data-param="note"]');
    note.value = "draft";
    note.focus();
    c.ws.receive(H.event("alerts", 2, [{ level: "info", message: "hi" }], {}));
    c.ws.receive(H.summaryEvent(2, { ...H.SUMMARY, cpu: "7%" }, {}));
    assert.equal(c.$('[data-param="note"]'), note, "the control was not rebuilt");
    assert.equal(note.value, "draft");
    assert.equal(c.document.activeElement, note);
  });
});

describe("4.5 Running", () => {
  it("shows progress, disables Run and offers Cancel on a cancellable node", () => {
    const c = boot({ hash: "#tools.survey" });
    click(c.$('[data-menu-action="run"]'));
    assert.equal(c.$('[data-menu-action="run"]').disabled, true, "disabled at once, before the server answers");
    const inv = c.invokes()[0];
    c.ws.receive(job("tools.survey", "queued", { id: inv.id }));
    c.ws.receive(job("tools.survey", "progress", { progress: { pct: 35, message: "Scanning on wlan0…" } }));
    const region = c.$("#menu-result");
    assert.equal(region.getAttribute("aria-busy"), "true");
    assert.match(text(region), /Scanning on wlan0…/);
    const bar = region.querySelector("progress");
    assert.equal(bar.getAttribute("value"), "35");
    assert.equal(bar.getAttribute("max"), "100");
    assert.match(text(region.querySelector(".menu-running-pct")), /^35 %$/);
    click(c.$('[data-menu-action="run"]'));
    assert.equal(c.invokes().length, 1, "a second press while live sends nothing");

    click(region.querySelector('[data-menu-action="cancel-job"]'));
    assert.deepEqual(c.sent("cancel").map((f) => f.job_id), ["j001"]);
    c.ws.receive(job("tools.survey", "cancelled", { id: c.sent("cancel")[0].id }));
    assert.match(text(c.$("#menu-result")), /^Cancelled at \d\d:\d\d:\d\d\.$/);
    assert.equal(c.$('[data-menu-action="run"]').disabled, false);
  });

  it("an indeterminate job has a bar without a value and no Cancel unless cancellable", () => {
    const c = boot({ hash: "#net.ifaces" });
    c.ws.receive(job("net.ifaces", "queued", { id: c.invokes()[0].id }));
    c.ws.receive(job("net.ifaces", "progress", { progress: { pct: null } }));
    const bar = c.$("#menu-result progress");
    assert.equal(bar.hasAttribute("value"), false);
    assert.match(text(c.$("#menu-result")), /Working…/);
    assert.equal(c.$('#menu-result [data-menu-action="cancel-job"]'), null);
  });

  it("leaving a running job does not cancel it; its result is offered when it finishes", () => {
    const c = boot({ hash: "#tools.speed" });
    c.ws.receive(job("tools.speed", "queued", { id: c.invokes()[0].id }));
    c.go("#net");
    assert.equal(c.sent("cancel").length, 0);
    assert.match(text(c.$(".menu-activity-chip")), /1 running/);
    c.ws.receive(job("tools.speed", "result", { result: { blocks: [{ type: "text", text: "500 Mbps" }] } }));
    const notice = c.$(".menu-notice");
    assert.match(text(notice), /Speed finished\./);
    const link = notice.querySelector("a");
    assert.equal(link.getAttribute("href"), "#tools.speed");
    assert.equal(text(link), "View result");
    assert.equal(c.$(".menu-activity-chip"), null, "the chip goes when nothing is running");
    c.go("#tools.speed");
    assert.match(text(c.$("#menu-result")), /500 Mbps/, "stored against its node");
    assert.equal(c.$(".menu-notice"), null);
  });
});

describe("4.6 Result with paging", () => {
  function scan() {
    const c = boot({ hash: "#tools.survey" });
    click(c.$('[data-menu-action="run"]'));
    c.finish("tools.survey", [tableBlock(rowsFrom(0, 20))], { result: { cursor: "cPAGE1", total: 45 } });
    return c;
  }

  it("shows the count and Load more only while there is a cursor", () => {
    const c = scan();
    assert.equal(text(c.$(".menu-paging-count")), "Showing 20 of 45");
    const more = c.$('[data-menu-action="load-more"]');
    assert.equal(text(more), "Load more");
    click(more);
    const pages = c.sent("page");
    assert.equal(pages.length, 1);
    assert.equal(pages[0].job_id, "j001");
    assert.equal(pages[0].cursor, "cPAGE1");
    assert.equal(c.$('[data-menu-action="load-more"]').disabled, true, "no double page while one is loading");

    c.ws.receive(job("tools.survey", "result", { id: pages[0].id, result: { blocks: [tableBlock(rowsFrom(20, 20))], cursor: "cPAGE2", total: 45 } }));
    assert.equal(c.$$("#menu-result table").length, 1, "rows are appended to the existing table");
    assert.equal(c.$$("#menu-result tbody tr").length, 40);
    assert.equal(text(c.$(".menu-paging-count")), "Showing 40 of 45");

    click(c.$('[data-menu-action="load-more"]'));
    c.ws.receive(job("tools.survey", "result", { id: c.sent("page")[1].id, result: { blocks: [tableBlock(rowsFrom(40, 5))], cursor: null, total: 45 } }));
    assert.equal(c.$$("#menu-result tbody tr").length, 45);
    assert.equal(c.$('[data-menu-action="load-more"]'), null, "no cursor: no button");
    assert.equal(c.$(".menu-paging"), null);
    assert.equal(c.invokes().length, 1, "paging never re-runs the action");
  });

  it("a result without a cursor shows no paging at all", () => {
    const c = boot({ hash: "#net.ifaces" });
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 3))], { result: { total: 3 } });
    assert.equal(c.$(".menu-paging"), null);
  });

  it("a shared result says so", () => {
    const c = boot({ hash: "#net.ifaces" });
    c.ws.receive(job("net.ifaces", "result", {
      id: c.invokes()[0].id, shared: true, cached_at: "2026-11-10T12:04:10Z", result: { blocks: [tableBlock(rowsFrom(0, 1))] },
    }));
    assert.match(text(c.$(".menu-shared")), /^Shared result from \d\d:\d\d:\d\d$/);
  });
});

describe("4.7 Mutating action and inline confirm", () => {
  it("opening a mutating node sends no invoke; Run then confirm sends exactly one with confirmed: true", () => {
    const c = boot({ hash: "#sys.restart" });
    assert.equal(c.invokes().length, 0);
    assert.match(text(c.$(".menu-mutates")), /This changes the device\./);
    assert.ok(c.$(".menu-mutates [uk-icon]"));
    const run = c.$('[data-menu-action="run"]');
    assert.equal(text(run), "Restart", "the button is the node's label");
    assert.match(text(c.$(".menu-run-text")), /Restart the device now\?/);

    click(run);
    assert.equal(c.invokes().length, 0, "pressing Run only opens the confirmation");
    assert.equal(c.$('[data-menu-action="run"]'), null, "the button row is swapped for the confirm row");
    const no = c.$('[data-menu-action="confirm-no"]');
    const yes = c.$('[data-menu-action="confirm-yes"]');
    assert.equal(text(no), "Keep running");
    assert.equal(text(yes), "Restart");
    assert.equal(c.document.activeElement, no, "focus moves to Cancel");
    assert.ok(yes.classList.contains("uk-button-danger"), "a destructive confirm uses the danger style");

    click(yes);
    assert.equal(c.invokes().length, 1);
    assert.equal(c.invokes()[0].node, "sys.restart");
    assert.equal(c.invokes()[0].confirmed, true);
    assert.equal(c.invokes()[0].params, undefined);
    assert.equal(c.$('[data-menu-action="confirm-yes"]'), null);
  });

  it("Cancel in the confirm row sends nothing and returns to the button", () => {
    const c = boot({ hash: "#sys.restart" });
    click(c.$('[data-menu-action="run"]'));
    click(c.$('[data-menu-action="confirm-no"]'));
    assert.equal(c.invokes().length, 0);
    assert.equal(c.document.activeElement, c.$('[data-menu-action="run"]'));
  });

  it("a mutation without confirm waits for its button and then runs once", () => {
    const c = boot({ hash: "#tools.radio_on" });
    assert.equal(c.invokes().length, 0);
    assert.equal(text(c.$('[data-menu-action="run"]')), "Radio On");
    assert.match(text(c.$(".menu-idle")), /Nothing has been changed/);
    click(c.$('[data-menu-action="run"]'));
    assert.equal(c.invokes().length, 1);
    assert.equal(c.invokes()[0].confirmed, undefined);
  });

  it("a node without `mutates` is not run on arrival", () => {
    const c = boot({ hash: "#tools.legacy" });
    assert.equal(c.invokes().length, 0);
    assert.ok(c.$('[data-menu-action="run"]'));
    assert.ok(c.$(".menu-mutates"));
  });

  it("reload, Back and Forward never run a Run page", () => {
    // Reload: a new page at the same URL.
    for (const hash of ["#sys.restart", "#tools.radio_on", "#tools.legacy", "#tools.survey", "#sys.region", "#tools.capture.more.start"]) {
      const c = boot({ hash });
      assert.equal(c.invokes().length, 0, `${hash}: reload sends no invoke`);
    }
    // Back and Forward: hash changes over mutating pages.
    const c = boot();
    for (const hash of ["#sys", "#sys.restart", "#tools.radio_on", "#sys.restart", "#sys", "#tools.legacy", "#sys.region", "#"]) c.go(hash);
    assert.equal(c.invokes().length, 0);
    // Even with a confirmation open, leaving and coming back does not carry it over.
    c.go("#sys.restart");
    click(c.$('[data-menu-action="run"]'));
    c.go("#sys");
    c.go("#sys.restart");
    assert.ok(c.$('[data-menu-action="run"]'), "the confirm row is gone");
    assert.equal(c.invokes().length, 0);
  });

  it("a result of a mutation stays with its timestamp until the user runs again", () => {
    const c = boot({ hash: "#tools.radio_on" });
    click(c.$('[data-menu-action="run"]'));
    c.finish("tools.radio_on", [{ type: "status", level: "ok", text: "Radio on" }]);
    c.go("#tools");
    c.go("#tools.radio_on");
    assert.match(text(c.$("#menu-result")), /Radio on/);
    assert.match(text(c.$(".menu-updated")), /^Updated/);
    assert.equal(c.invokes().length, 1, "returning never re-runs it");
  });
});

describe("4.8 Error and cancelled", () => {
  it("a job error shows the copy for its code with Try again; no toast", () => {
    const c = boot({ hash: "#net.public" });
    c.ws.receive(job("net.public", "queued", { id: c.invokes()[0].id }));
    c.ws.receive(job("net.public", "error", { error: { code: "CORE_UNAVAILABLE", message: "connection refused" } }));
    const alert = c.$("#menu-result [role=alert]");
    assert.match(text(alert), /Error Device services are not responding\./);
    assert.match(text(alert.querySelector("details")), /Details\s*connection refused/);
    click(c.$('[data-menu-action="retry"]'));
    assert.equal(c.invokes().length, 2, "Try again on a read-only page runs it again");
  });

  it("copy by error code", () => {
    const copy = (code, message) => Pages.errorCopy({ code, message });
    assert.deepEqual(copy("FORBIDDEN", "x"), { text: "Your account is not allowed to do this.", detail: "x" });
    assert.deepEqual(copy("CONFLICT", "Stop the profiler before purging"), { text: "Stop the profiler before purging", detail: null });
    assert.equal(copy("NOT_FOUND", "").text, "This item is no longer available.");
    assert.equal(copy("CORE_UNAVAILABLE", "").text, "Device services are not responding.");
    assert.equal(copy("TIMEOUT", "").text, "This took too long and was stopped.");
    assert.deepEqual(copy("BAD_REQUEST", "adapter: must be {iface, namespace}"), { text: "Something went wrong.", detail: "adapter: must be {iface, namespace}" });
    assert.deepEqual(copy("INTERNAL", "KeyError: x"), { text: "Something went wrong.", detail: "KeyError: x" });
  });

  it("a refused request is shown where it was made", () => {
    const c = boot({ hash: "#tools.radio_on" });
    click(c.$('[data-menu-action="run"]'));
    c.ws.receive({ ...H.sample("s2c", "error.conflict.json"), id: c.invokes()[0].id });
    const alert = c.$("#menu-result [role=alert]");
    assert.equal(alert.getAttribute("data-code"), "CONFLICT");
    assert.match(text(alert), new RegExp(H.sample("s2c", "error.conflict.json").message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(c.document.querySelector(".uk-notification"), null, "no toast");
    assert.equal(c.$('[data-menu-action="run"]').disabled, false);
  });

  it("Try again on a confirm page goes through the confirmation again", () => {
    const c = boot({ hash: "#sys.restart" });
    click(c.$('[data-menu-action="run"]'));
    click(c.$('[data-menu-action="confirm-yes"]'));
    c.ws.receive(job("sys.restart", "error", { id: c.invokes()[0].id, error: { code: "TIMEOUT", message: "took longer than 30 s" } }));
    click(c.$('[data-menu-action="retry"]'));
    assert.equal(c.invokes().length, 1, "not re-run without a new confirmation");
    assert.ok(c.$('[data-menu-action="confirm-yes"]'));
  });

  it("cancelled shows when", () => {
    const c = boot({ hash: "#net.ifaces" });
    c.ws.receive(job("net.ifaces", "cancelled", { id: c.invokes()[0].id }));
    assert.match(text(c.$(".menu-cancelled")), /^Cancelled at \d\d:\d\d:\d\d\. Run again$/);
  });
});

describe("4.13 Not available", () => {
  it("an unknown or hidden hash shows the page, not an error, and runs nothing", () => {
    for (const hash of ["#nope", "#tools.hidden_by_role", "#constructor"]) {
      const c = boot({ hash });
      assert.equal(text(c.$("#menu-page-title")), "This item is not available");
      assert.match(text(c.page()), /hidden in the current device mode, or your account may not have access/);
      assert.equal(c.$('#menu-page a.uk-button').getAttribute("href"), "#");
      assert.equal(text(c.$('#menu-page a.uk-button')), "Go to Home");
      assert.equal(c.invokes().length, 0);
    }
  });

  it("a menu replaced while live keeps the page if the node still exists, else not-available", () => {
    const c = boot({ hash: "#tools.survey" });
    c.$('[data-param="adapter"]').value = "wlan1";
    const m = H.menuFrame();
    c.ws.receive(H.assertS2C({ ...m, revision: 2, nodes: m.nodes.filter((n) => n.id !== "net.public") }));
    assert.equal(text(c.$("#menu-page-title")), "Survey", "still there: kept");
    assert.equal(c.$('[data-param="adapter"]').value, "wlan1");
    c.ws.receive(H.assertS2C({ ...m, revision: 3, device_mode: "hotspot", nodes: m.nodes.filter((n) => !n.id.startsWith("tools")) }));
    assert.equal(text(c.$("#menu-page-title")), "This item is not available");
    assert.equal(c.$('#menu-sidebar a[href="#tools"]'), null, "the tree was replaced");
    assert.equal(c.invokes().length, 0);
  });

  it("the skip link's #content is an in-page anchor, not a menu location", () => {
    const c = boot({ hash: "#net" });
    c.go("#content");
    assert.equal(text(c.$("#menu-page-title")), "Net");
  });
});

describe("4.14 Connecting (first load)", () => {
  it("shows a skeleton and the connecting line, with no banner", () => {
    const c = boot({ live: false, hash: "#net.ifaces" });
    assert.match(text(c.page()), /Connecting to the device menu…/);
    assert.equal(c.$("#menu-banner").hidden, true, "first load is not an error");
    assert.ok(c.$("#menu-statusbar .menu-skel"));
    assert.ok(c.$("#menu-sidebar .menu-skel"));
    assert.equal(c.panel.classList.contains("is-stale"), false);
    c.ws.open();
    assert.equal(c.invokes().length, 0, "nothing runs before the menu arrives");
    c.ws.receive(H.welcome());
    assert.equal(c.invokes().length, 0);
    c.ws.receive(H.menuFrame());
    assert.equal(c.invokes().length, 1, "then the deep-linked read-only page runs once");
    assert.equal(c.$("#menu-banner").hidden, true, "being connected is not news");
  });
});

describe("4.15 Connection lost", () => {
  function lose(code = 1006, hash = "#net.ifaces") {
    const c = boot({ hash });
    if (hash === "#net.ifaces") c.finish("net.ifaces", [tableBlock(rowsFrom(0, 3))]);
    c.ws.serverClose(code);
    return c;
  }

  it("keeps the content under a banner with a countdown and Retry now", () => {
    const c = lose();
    const banner = c.$("#menu-banner");
    assert.equal(banner.hidden, false);
    assert.equal(banner.getAttribute("role"), "status");
    assert.match(text(banner), /^Connection lost\. Retrying in 1 s\.\s*Retry now$/);
    assert.equal(c.$("#menu-result").querySelectorAll("tbody tr").length, 3, "the last result is still there");
    assert.ok(c.panel.classList.contains("is-stale"));
    assert.equal(c.$('[data-menu-action="refresh"]').disabled, true);
    assert.match(text(c.$("#menu-statusbar .menu-sb-asof")), /^\(as of \d\d:\d\d:\d\d\)$/);
    assert.equal(text(c.$("#menu-live")), "Connection lost");
    assert.equal(c.document.querySelector(".uk-notification"), null);
  });

  it("the countdown is visible and the banner turns to Reconnecting when the timer fires", () => {
    const c = lose();
    c.timers.advance(1000);
    assert.match(text(c.$("#menu-banner")), /^Reconnecting…$/);
    c.ws.serverClose(1006);
    assert.match(text(c.$("#menu-banner")), /Retrying in 2 s\./);
    c.timers.advance(1000);
    assert.match(text(c.$("#menu-banner")), /Retrying in 1 s\./);
    c.timers.advance(1000);
    c.ws.serverClose(1006);
    assert.match(text(c.$("#menu-banner")), /Retrying in 4 s\./);
  });

  it("Retry now reconnects at once", () => {
    const c = lose();
    const n = c.WS.sockets.length;
    click(c.$('[data-menu-action="retry-now"]'));
    assert.equal(c.WS.sockets.length, n + 1);
    assert.match(text(c.$("#menu-banner")), /Reconnecting…/);
  });

  it("close 1001 and 1013 have their own copy", () => {
    assert.match(text(lose(1001).$("#menu-banner")), /^The menu service is restarting\. Retrying in 1 s\./);
    assert.match(text(lose(1013).$("#menu-banner")), /^The device has too many menu sessions open\. Retrying in 10 s\./);
  });

  it("sends hello.resume and, when resumed, redraws nothing and runs nothing", () => {
    const c = lose();
    const table = c.$("#menu-result table");
    c.timers.advance(1000);
    c.ws.open();
    const hello = c.ws.sent[0];
    assert.equal(hello.resume.epoch, "epoch-0001");
    assert.equal(hello.resume.session_id, "sess-0001");
    assert.deepEqual(hello.resume.seq, { "device.summary": 1, alerts: 1, complications: 1, jobs: 1 });
    assert.equal(hello.resume.menu_revision, 1);
    c.ws.receive(H.welcome({ resumed: true }));
    assert.equal(c.$("#menu-banner").hidden, true);
    assert.equal(c.panel.classList.contains("is-stale"), false);
    assert.equal(c.$("#menu-result table"), table, "the result was not redrawn");
    assert.equal(c.invokes().length, 1, "no re-run");
    assert.equal(c.sent("subscribe").length, 1, "subscriptions continue");
    assert.equal(c.$('[data-menu-action="refresh"]').disabled, false);
    assert.equal(text(c.$("#menu-live")), "Connected again");
  });

  it("when not resumed: subscribes again, takes the snapshot, and refreshes an auto-run page once", () => {
    const c = lose(1001);
    c.timers.advance(1000);
    c.ws.open();
    c.ws.receive(H.welcome({ resumed: false, epoch: "epoch-0002", session_id: "sess-0002" }));
    c.ws.receive(H.menuFrame({ revision: 5 }));
    c.ws.receive(H.summaryEvent(1, { ...H.SUMMARY, hostname: "wlanpi-new" }));
    assert.equal(c.sent("subscribe").length, 2);
    assert.equal(c.invokes().length, 2, "the read-only page refreshes exactly once");
    assert.match(text(c.$("#menu-statusbar")), /wlanpi-new/);
    assert.equal(c.$("#menu-result").querySelectorAll("tbody tr").length, 3, "the old result stays until the new one lands");
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 2))], { job_id: "j002" });
    assert.equal(c.$("#menu-result").querySelectorAll("tbody tr").length, 2);
    assert.equal(c.invokes().length, 2);
  });

  it("never re-runs a Run page after a reconnect", () => {
    for (const hash of ["#sys.restart", "#tools.radio_on", "#tools.survey"]) {
      const c = lose(1001, hash);
      assert.equal(c.$('[data-menu-action="run"]').disabled, true, "Run is disabled while disconnected");
      c.timers.advance(1000);
      c.ws.open();
      c.ws.receive(H.welcome({ resumed: false, epoch: "epoch-0002", session_id: "sess-0002" }));
      c.ws.receive(H.menuFrame({ revision: 5 }));
      assert.equal(c.invokes().length, 0, hash);
      assert.equal(c.$('[data-menu-action="run"]').disabled, false);
    }
  });

  it("an open confirmation does not survive a dropped connection", () => {
    const c = boot({ hash: "#sys.restart" });
    click(c.$('[data-menu-action="run"]'));
    c.ws.serverClose(1006);
    c.timers.advance(1000);
    c.ws.open();
    c.ws.receive(H.welcome({ resumed: true }));
    assert.equal(c.$('[data-menu-action="confirm-yes"]'), null);
    assert.equal(c.invokes().length, 0);
  });

  it("a page opened while offline runs when the connection is back", () => {
    const c = lose();
    c.go("#net.public");
    assert.equal(c.invokes("net.public").length, 0, "nothing can be sent while disconnected");
    c.timers.advance(1000);
    c.ws.open();
    c.ws.receive(H.welcome({ resumed: true }));
    assert.equal(c.invokes("net.public").length, 1);
  });
});

describe("4.16 Terminal states", () => {
  function closed(code) {
    const c = boot({ hash: "#net.ifaces" });
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 3))]);
    c.ws.serverClose(code);
    return c;
  }

  it("4401: signed out, content kept and dimmed, Sign in, no retry", () => {
    const c = closed(4401);
    const banner = c.$("#menu-banner");
    assert.equal(banner.getAttribute("role"), "alert");
    assert.match(text(banner), /^You have been signed out\.\s*Sign in$/);
    assert.equal(banner.querySelector("a").getAttribute("href"), "/login");
    assert.equal(c.$('[data-menu-action="retry-now"]'), null);
    assert.equal(c.$("#menu-result").querySelectorAll("tbody tr").length, 3);
    assert.ok(c.panel.classList.contains("is-stale"));
    const n = c.WS.sockets.length;
    c.timers.advance(600000);
    assert.equal(c.WS.sockets.length, n);
  });

  it("4426 and 4400: out of date, Reload", () => {
    for (const code of [4426, 4400]) {
      const c = closed(code);
      assert.match(text(c.$("#menu-banner")), /^This page is out of date\.\s*Reload$/);
      assert.ok(c.$('[data-menu-action="reload"]'));
    }
  });

  it("1008: refused, no button", () => {
    const c = closed(1008);
    assert.match(text(c.$("#menu-banner")), /^This address is not allowed to open the device menu\. Open the WebUI using the device's own hostname or IP\.$/);
    assert.equal(c.$("#menu-banner button"), null);
  });
});

describe("4.17 Core unavailable (socket live)", () => {
  it("is a status bar condition and a Home notice, not a connection state", () => {
    const c = boot({ summary: { core: "unavailable", ip: "192.168.1.42" } });
    const bar = c.$("#menu-statusbar");
    assert.match(text(bar), /^Device services are not responding\s*192\.168\.1\.42$/);
    assert.ok(bar.classList.contains("is-core-down"));
    assert.ok(bar.querySelector(".menu-sb-down [uk-icon]"));
    assert.equal(c.$("#menu-banner").hidden, true, "the socket is fine");
    assert.equal(c.panel.classList.contains("is-stale"), false);
    assert.match(text(c.$(".menu-core-down")), /Device services are not responding\. The menu will work again when they are back\./);
    assert.ok(c.$$(".menu-card").length > 0, "the menu stays usable");
  });

  it("action pages show the error state", () => {
    const c = boot({ hash: "#net.ifaces", summary: { core: "unavailable" } });
    c.ws.receive(job("net.ifaces", "error", { id: c.invokes()[0].id, error: { code: "CORE_UNAVAILABLE", message: "core unreachable" } }));
    assert.match(text(c.$("#menu-result [role=alert]")), /Device services are not responding\./);
    assert.equal(c.$('[data-menu-action="refresh"]').disabled, false, "the page stays live");
  });
});

describe("Activity", () => {
  it("lists own jobs with progress and Cancel, and other surfaces' jobs without controls", () => {
    const c = boot({ hash: "#tools.speed" });
    c.ws.receive(job("tools.speed", "queued", { id: c.invokes()[0].id, job_id: "j005" }));
    c.ws.receive(job("tools.speed", "progress", { job_id: "j005", progress: { pct: 40 } }));
    c.ws.receive(H.event("jobs", 2, [
      { job_id: "j005", node: "tools.speed", state: "progress", sessions: 1 },
      { job_id: "j009", node: "tools.capture.more.start", state: "progress", sessions: 1 },
    ], {}));
    const chip = c.$(".menu-activity-chip");
    assert.match(text(chip), /2 running/);
    assert.equal(chip.getAttribute("aria-expanded"), "false");
    click(chip);
    assert.equal(c.$(".menu-activity-chip").getAttribute("aria-expanded"), "true");
    assert.ok(c.$(".menu-activity-drop").classList.contains("uk-open"));
    const items = c.$$(".menu-activity-item");
    assert.equal(items.length, 2);
    assert.match(text(items[0]), /Tools › Speed\s*40 %/);
    assert.equal(items[0].querySelector("a").getAttribute("href"), "#tools.speed");
    assert.ok(items[0].querySelector('[data-menu-action="cancel-job"]'));
    assert.match(text(items[1]), /Tools › Capture › More Capture › Begin\s*started from another surface/);
    assert.equal(items[1].querySelector("button"), null);
    click(items[0].querySelector('[data-menu-action="cancel-job"]'));
    assert.deepEqual(c.sent("cancel").map((f) => f.job_id), ["j005"]);
    H.key(c.document.body, "Escape");
    assert.equal(c.$(".menu-activity-drop").classList.contains("uk-open"), false);
  });
});

describe("Narrow tables and secrets", () => {
  it("drops columns by priority, highest number first, and offers them per row", () => {
    const { document } = H.makeDom({ html: "<div id='t'></div>" });
    const host = document.getElementById("t");
    host.innerHTML = H.load("view_blocks.js").renderBlocks([tableBlock(rowsFrom(0, 2))]);
    const table = host.querySelector("table");
    const visible = () => Array.from(table.querySelectorAll("thead th[data-col]")).filter((th) => !th.hidden).map((th) => th.textContent);
    // Pretend the table fits once two columns are gone.
    Pages.fitTables(host, () => visible().length > 2);
    assert.deepEqual(visible(), ["Name", "State"], "priority 3 went first, then 2; unprioritised and priority 1 stay");
    assert.equal(host.querySelector(".block-table").getAttribute("data-dropped"), "2");
    const btn = table.querySelector("tbody tr .table-expander-btn");
    assert.equal(btn.closest("td").hidden, false);
    click(btn);
    H.load("view_blocks.js").handleClick({ target: btn });
    const detail = table.querySelector(".table-detail-row");
    assert.equal(btn.getAttribute("aria-expanded"), "true");
    assert.deepEqual(Array.from(detail.querySelectorAll("dt")).map((e) => e.textContent), ["MAC", "Speed"]);
    assert.deepEqual(Array.from(detail.querySelectorAll("dd")).map((e) => e.textContent), ["00:00:00:00:00:00", "0"]);
    H.load("view_blocks.js").handleClick({ target: btn });
    assert.equal(table.querySelector(".table-detail-row"), null);

    Pages.fitTables(host, () => false);
    assert.deepEqual(visible(), ["Name", "State", "MAC", "Speed"], "everything returns when it fits");
    assert.equal(table.querySelector("tbody .table-expander-cell").hidden, true);

    Pages.fitTables(host, () => true);
    assert.deepEqual(visible(), ["Name"], "columns without a priority are never dropped; the rest scrolls");
  });

  it("the secret toggle is a real button exposing aria-pressed, handled by delegation", () => {
    const c = boot({ hash: "#net.public" });
    c.finish("net.public", [{ type: "kv", text: "x", items: [{ key: "Passphrase", value: "s3cret", secret: true }] }]);
    const btn = c.$(".toggle-secret-btn");
    assert.equal(btn.tagName, "BUTTON");
    assert.equal(btn.getAttribute("onclick"), null);
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    assert.equal(c.$(".kv-secret-plain").hidden, true);
    click(btn);
    assert.equal(btn.getAttribute("aria-pressed"), "true");
    assert.equal(c.$(".kv-secret-plain").hidden, false);
    assert.equal(c.$(".kv-secret-mask").hidden, true);
    click(btn);
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    assert.equal(c.window.wlanpiToggleSecret, undefined);
  });
});

describe("Leaving and returning", () => {
  it("closes both connections with 1000 and resumes on return within the grace", () => {
    const storage = new MemoryStorage();
    const c = boot({ hash: "#net.ifaces", storage });
    c.finish("net.ifaces", [tableBlock(rowsFrom(0, 3))]);
    click(c.$("#menu-panel-toggle"));
    const menuWs = c.ws;
    const paneWs = c.paneWs;
    paneWs.open();
    c.app.teardown();
    assert.deepEqual([menuWs.closed.code, paneWs.closed.code], [1000, 1000]);
    assert.equal(storage.getItem("wlanpi-menu-front-panel"), "1", "leaving does not forget the pane choice");

    // htmx swaps the page back in: a new element, the same module.
    const dom2 = H.makeDom({ hash: "#net.ifaces" });
    const WS2 = H.fakeSocketFactory();
    const app2 = Main.createApp({
      win: dom2.window, panel: dom2.panel, WebSocket: WS2, storage: null,
      now: c.timers.now, setTimeout: c.timers.setTimeout, clearTimeout: c.timers.clearTimeout, checkSignedOut: () => null,
    });
    assert.equal(dom2.panel.querySelectorAll("#menu-result tbody tr").length, 3, "the last result is shown at once");
    const ws2 = WS2.sockets[0];
    ws2.open();
    assert.equal(ws2.sent[0].resume.session_id, "sess-0001");
    ws2.receive(H.welcome({ resumed: true }));
    assert.equal(ws2.ofType("invoke").length, 1, "the read-only page refreshes in place");
    app2.teardown(false);
  });

  it("does not resume after the grace has passed", () => {
    const c = boot({ hash: "#net" });
    c.app.teardown();
    c.timers.advance(200000);
    const dom2 = H.makeDom({ hash: "#net" });
    const WS2 = H.fakeSocketFactory();
    const app2 = Main.createApp({ win: dom2.window, panel: dom2.panel, WebSocket: WS2, storage: null, now: c.timers.now, checkSignedOut: () => null });
    WS2.sockets[0].open();
    assert.equal(WS2.sockets[0].sent[0].resume, undefined);
    assert.match(H.text(dom2.panel.querySelector("#menu-page")), /Connecting to the device menu/);
    app2.teardown(false);
  });
});

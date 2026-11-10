import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ViewBlocks = require("../../wlanpi_webui/static/js/view_blocks.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, "../../../wlanpi-menud/protocol/samples/frames/s2c");

function loadFixture(filename) {
  const filePath = path.join(SAMPLES_DIR, filename);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("ViewBlocks Renderer against Recorded Frame Fixtures", () => {
  it("renders text blocks with correct styling and HTML escaping", () => {
    const fixture = loadFixture("job.result.blocks.json");
    const textBlock = fixture.result.blocks.find((b) => b.type === "text");
    assert.ok(textBlock, "text block found in fixture");

    const html = ViewBlocks.renderBlock(textBlock);
    assert.match(html, /class="[^"]*block-text[^"]*"/);
    assert.match(html, /class="[^"]*block-heading[^"]*"/);
    assert.match(html, /Profiler running/);

    // Test other styles and HTML escaping
    const monoBlock = { type: "text", style: "mono", text: "line1\n<script>alert(1)</script>" };
    const monoHtml = ViewBlocks.renderBlock(monoBlock);
    assert.match(monoHtml, /block-mono/);
    assert.match(monoHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(monoHtml, /<script>/);

    const mutedBlock = { type: "text", style: "muted", text: "Muted note" };
    assert.match(ViewBlocks.renderBlock(mutedBlock), /uk-text-muted/);
  });

  it("renders kv blocks from view.home.json and handles secret masking", () => {
    const fixture = loadFixture("view.home.json");
    const kvBlock = fixture.blocks.find((b) => b.type === "kv");
    assert.ok(kvBlock, "kv block found in view.home.json");

    const html = ViewBlocks.renderBlock(kvBlock);
    assert.match(html, /block-kv/);
    assert.match(html, /eth0/);
    assert.match(html, /192\.0\.2\.10/);
    assert.match(html, /Mode/);
    assert.match(html, /Classic/);

    // Test secret masking
    const secretKv = {
      type: "kv",
      text: "PSK: secret123",
      items: [
        { key: "SSID", value: "MyWifi" },
        { key: "Passphrase", value: "secret123", secret: true },
      ],
    };
    const secretHtml = ViewBlocks.renderBlock(secretKv);
    assert.match(secretHtml, /••••••••/);
    assert.match(secretHtml, /toggle-secret-btn/);
    assert.match(secretHtml, /secret123/);
  });

  it("renders table blocks with alignment from job.result.json", () => {
    const fixture = loadFixture("job.result.json");
    const tableBlock = fixture.result.blocks.find((b) => b.type === "table");
    assert.ok(tableBlock, "table block found in job.result.json");

    const html = ViewBlocks.renderBlock(tableBlock);
    assert.match(html, /block-table/);
    assert.match(html, /<table/);
    assert.match(html, /<th[^>]*>SSID<\/th>/);
    assert.match(html, /<th[^>]*class="uk-text-right"[^>]*>CH<\/th>/);
    assert.match(html, /<th[^>]*class="uk-text-right"[^>]*>RSSI<\/th>/);
    assert.match(html, /<td[^>]*>CorpNet<\/td>/);
    assert.match(html, /<td[^>]*class="uk-text-right"[^>]*>36<\/td>/);
    assert.match(html, /<td[^>]*class="uk-text-right"[^>]*>-51<\/td>/);
  });

  it("renders list blocks with cursor selection from view.mirror.json", () => {
    const fixture = loadFixture("view.mirror.json");
    const listBlock = fixture.blocks.find((b) => b.type === "list");
    assert.ok(listBlock, "list block found in view.mirror.json");

    const html = ViewBlocks.renderBlock(listBlock);
    assert.match(html, /block-list/);
    assert.match(html, /Interfaces/);
    assert.match(html, /Adapters/);
    assert.match(html, /Eth0 IP Config/);
    assert.match(html, /data-index="1"/);
    // Index 1 was selected in fixture
    assert.match(html, /›/);
    assert.match(html, /class="list-item list-item-selected" data-index="1"/);
  });

  it("renders qr blocks with payload data and caption from job.result.blocks.json", () => {
    const fixture = loadFixture("job.result.blocks.json");
    const qrBlock = fixture.result.blocks.find((b) => b.type === "qr");
    assert.ok(qrBlock, "qr block found in fixture");

    const html = ViewBlocks.renderBlock(qrBlock);
    assert.match(html, /block-qr/);
    assert.match(html, /data-qr-payload="WIFI:S:WLAN Pi;T:WPA;P:example-passphrase;;"/);
    assert.match(html, /Join profiler/);
    assert.match(html, /SSID: WLAN Pi/);
  });

  it("renders status blocks with appropriate severity level from view.home.json", () => {
    const fixture = loadFixture("view.home.json");
    const statusBlock = fixture.blocks.find((b) => b.type === "status");
    assert.ok(statusBlock, "status block found in fixture");

    const okHtml = ViewBlocks.renderBlock(statusBlock);
    assert.match(okHtml, /uk-alert-success/);
    assert.match(okHtml, /Profiler: running/);

    const warnHtml = ViewBlocks.renderBlock({
      type: "status",
      level: "warn",
      label: "Battery",
      text: "Battery low (15%)",
    });
    assert.match(warnHtml, /uk-alert-warning/);
    assert.match(warnHtml, /Battery/i);

    const errorHtml = ViewBlocks.renderBlock({
      type: "status",
      level: "error",
      text: "Adapter disconnected",
    });
    assert.match(errorHtml, /uk-alert-danger/);
  });

  it("renders progress blocks with percentage and indeterminate state", () => {
    const fixture = loadFixture("job.result.blocks.json");
    const progressBlock = fixture.result.blocks.find((b) => b.type === "progress");
    assert.ok(progressBlock, "progress block found in fixture");

    const html = ViewBlocks.renderBlock(progressBlock);
    assert.match(html, /block-progress/);
    assert.match(html, /value="40"/);
    assert.match(html, /Capturing/);
    assert.match(html, /Capturing 40%/);

    // Indeterminate progress (pct: null)
    const indetHtml = ViewBlocks.renderBlock({
      type: "progress",
      pct: null,
      label: "Scanning",
      text: "Scanning channels...",
    });
    assert.match(indetHtml, /<progress class="uk-progress uk-margin-remove"[^>]*><\/progress>/);
    assert.doesNotMatch(indetHtml, /<progress[^>]*value=/);
    assert.match(indetHtml, /Scanning channels\.\.\./);
  });

  it("renders confirm blocks with prompt id and action buttons", () => {
    const fixture = loadFixture("job.result.blocks.json");
    const confirmBlock = fixture.result.blocks.find((b) => b.type === "confirm");
    assert.ok(confirmBlock, "confirm block found in fixture");

    const html = ViewBlocks.renderBlock(confirmBlock);
    assert.match(html, /block-confirm/);
    assert.match(html, /data-prompt-id="p91c5"/);
    assert.match(html, /Stop the profiler\?/);
    assert.match(html, /confirm-ok-btn/);
    assert.match(html, /confirm-cancel-btn/);
  });

  it("falls back to text for unknown block types and malformed payloads", () => {
    const unknownBlock = {
      type: "future_fancy_widget",
      text: "Fallback summary line for unsupported client widget",
      data: { foo: 123 },
    };
    const html = ViewBlocks.renderBlock(unknownBlock);
    assert.match(html, /block-fallback/);
    assert.match(html, /Fallback summary line for unsupported client widget/);

    // Malformed table (missing rows array)
    const badTable = {
      type: "table",
      text: "Table fallback text",
      columns: [{ key: "a", label: "A" }],
    };
    const badTableHtml = ViewBlocks.renderBlock(badTable);
    assert.match(badTableHtml, /block-fallback/);
    assert.match(badTableHtml, /Table fallback text/);
  });

  it("renders multiple blocks via renderBlocks", () => {
    const fixture = loadFixture("job.result.blocks.json");
    const html = ViewBlocks.renderBlocks(fixture.result.blocks);
    assert.match(html, /block-heading/);
    assert.match(html, /block-qr/);
    assert.match(html, /block-progress/);
    assert.match(html, /block-confirm/);
  });
});

// The redesign's edits to the shared renderer (design section 5.3), on a real DOM.
describe("ViewBlocks on the themed menu surface", () => {
  const { JSDOM } = require("jsdom");
  const mount = (html) => {
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="m">${html}</div></body>`);
    return { window: dom.window, root: dom.window.document.getElementById("m") };
  };
  const ALL = [
    { type: "text", text: "plain" },
    { type: "text", style: "heading", text: "Heading" },
    { type: "text", style: "mono", text: "mono" },
    { type: "kv", text: "k: v", items: [{ key: "k", value: "v" }, { key: "PSK", value: "hunter2", secret: true }] },
    { type: "table", text: "t", columns: [{ key: "a", label: "A" }, { key: "b", label: "B", priority: 2, align: "right" }], rows: [["1", 2]] },
    { type: "list", text: "l", items: [{ label: "One", node: "net.ifaces", branch: false }, { label: "Two", detail: "d" }], selected: 1 },
    { type: "qr", text: "WIFI:x", data: "WIFI:x", caption: "Join" },
    { type: "status", level: "warn", text: "Careful" },
    { type: "progress", text: "40%", pct: 40, label: "Working" },
    { type: "confirm", text: "Sure?", prompt_id: "p0001", message: "Sure?", confirm_label: "Yes", cancel_label: "No" },
    { type: "from_the_future", text: "fallback text" },
  ];

  it("uses no light-theme utility, inline style, inline handler or colour literal for any block type", () => {
    for (const opts of [undefined, { interactive: false, links: false }]) {
      const html = ViewBlocks.renderBlocks(ALL, opts);
      assert.doesNotMatch(html, /uk-background-muted|uk-table-striped|uk-card-secondary/);
      assert.doesNotMatch(html, /\sstyle=/);
      assert.doesNotMatch(html, /\son[a-z]+=/);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });

  it("every block type renders, and an unknown type falls back to its text", () => {
    const { root } = mount(ViewBlocks.renderBlocks(ALL));
    assert.equal(root.querySelectorAll(".view-block").length, ALL.length);
    assert.equal(root.querySelector(".block-fallback").textContent, "fallback text");
    assert.ok(root.children instanceof root.ownerDocument.defaultView.HTMLCollection);
  });

  it("tables carry column index and priority as data attributes, plus a hidden details expander", () => {
    const { root } = mount(ViewBlocks.renderBlock(ALL[4]));
    const heads = root.querySelectorAll("thead th[data-col]");
    assert.equal(heads.length, 2);
    assert.equal(heads[0].hasAttribute("data-priority"), false);
    assert.equal(heads[1].getAttribute("data-priority"), "2");
    assert.equal(root.querySelectorAll('tbody td[data-col="1"]').length, 1);
    const expander = root.querySelector("tbody .table-expander-cell");
    assert.equal(expander.hidden, true, "hidden until the page drops a column");
    const btn = expander.querySelector("button");
    assert.equal(btn.getAttribute("aria-expanded"), "false");
    // Dropped column -> the row's details list it.
    root.querySelectorAll('[data-col="1"]').forEach((el) => { el.hidden = true; });
    ViewBlocks.handleClick({ target: btn });
    assert.equal(btn.getAttribute("aria-expanded"), "true");
    assert.equal(root.querySelector(".table-detail-row dt").textContent, "B");
    assert.equal(root.querySelector(".table-detail-row dd").textContent, "2");
    ViewBlocks.handleClick({ target: btn });
    assert.equal(root.querySelector(".table-detail-row"), null);
  });

  it("list items with a node are links to #<node>; without links they are plain rows", () => {
    const { root } = mount(ViewBlocks.renderBlock(ALL[5]));
    const link = root.querySelector("li[data-node] a");
    assert.equal(link.getAttribute("href"), "#net.ifaces");
    assert.equal(root.querySelectorAll("a").length, 1, "an item without a node is not a link");
    const selected = root.querySelector(".list-item-selected");
    assert.equal(selected.getAttribute("data-index"), "1");
    assert.equal(selected.getAttribute("aria-current"), "true");
    const plain = mount(ViewBlocks.renderBlock(ALL[5], { links: false })).root;
    assert.equal(plain.querySelector("a"), null);
    assert.equal(plain.querySelectorAll(".list-item").length, 2);
  });

  it("the secret toggle is delegated and exposes aria-pressed", () => {
    const { root, window } = mount(ViewBlocks.renderBlock(ALL[3]));
    const btn = root.querySelector(".toggle-secret-btn");
    assert.equal(btn.getAttribute("onclick"), null);
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    assert.equal(root.querySelector(".kv-secret-plain").hidden, true);
    root.addEventListener("click", (evt) => ViewBlocks.handleClick(evt));
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(btn.getAttribute("aria-pressed"), "true");
    assert.equal(btn.textContent, "Hide");
    assert.equal(root.querySelector(".kv-secret-plain").hidden, false);
    assert.equal(root.querySelector(".kv-secret-mask").hidden, true);
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    assert.equal(root.querySelector(".kv-secret-plain").hidden, true);
    assert.equal(typeof globalThis.wlanpiToggleSecret, "undefined");
    assert.equal(ViewBlocks.handleClick({ target: root }), false, "other clicks are not block controls");
  });

  it("confirm has a non-interactive variant for a key-driven screen", () => {
    const interactive = mount(ViewBlocks.renderBlock(ALL[9])).root;
    assert.equal(interactive.querySelectorAll("button").length, 2);
    const still = mount(ViewBlocks.renderBlock({ ...ALL[9], selected: "confirm" }, { interactive: false })).root;
    assert.equal(still.querySelectorAll("button").length, 0);
    assert.match(still.textContent, /Sure\?/);
    assert.deepEqual(Array.from(still.querySelectorAll(".confirm-choice")).map((e) => e.textContent), ["No", "Yes"]);
    assert.equal(still.querySelector(".confirm-choice-selected").textContent, "Yes");
    const cancelSelected = mount(ViewBlocks.renderBlock(ALL[9], { interactive: false })).root;
    assert.equal(cancelSelected.querySelector(".confirm-choice-selected").textContent, "No", "the cursor starts on Cancel");
  });

  it("status carries an icon and a word, not colour alone", () => {
    for (const [level, word] of [["ok", "OK"], ["info", "Info"], ["warn", "Warning"], ["error", "Error"]]) {
      const { root } = mount(ViewBlocks.renderBlock({ type: "status", level, text: "x" }));
      assert.ok(root.querySelector("[uk-icon]"), level);
      assert.match(root.textContent, new RegExp("^" + word + ":"), level);
    }
  });
});

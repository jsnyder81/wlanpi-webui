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
    assert.match(html, /<th>SSID<\/th>/);
    assert.match(html, /<th class="uk-text-right">CH<\/th>/);
    assert.match(html, /<th class="uk-text-right">RSSI<\/th>/);
    assert.match(html, /<td>CorpNet<\/td>/);
    assert.match(html, /<td class="uk-text-right">36<\/td>/);
    assert.match(html, /<td class="uk-text-right">-51<\/td>/);
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
    assert.match(html, /uk-text-primary/);
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
    assert.match(indetHtml, /<progress class="uk-progress uk-margin-remove"><\/progress>/);
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

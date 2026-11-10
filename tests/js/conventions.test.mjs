// Static checks over the menu page's sources (design sections 2.1, 2.12, 3.2).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATIC, menuPartial } from "./helpers/harness.mjs";

const MENU_JS_DIR = path.join(STATIC, "js/menu");
const JS_FILES = fs.readdirSync(MENU_JS_DIR).filter((f) => f.endsWith(".js")).map((f) => path.join(MENU_JS_DIR, f))
  .concat([path.join(STATIC, "js/view_blocks.js")]);
const CSS_FILE = path.join(STATIC, "css/menu.css");
const PARTIAL = path.join(ROOT, "wlanpi_webui/templates/partials/menu.html");
const rel = (f) => path.relative(ROOT, f);

/**
 * Split JavaScript into its string literals and its code with comments and
 * string contents removed. Handles regex literals (some contain quotes).
 */
function lex(src) {
  const strings = [];
  let code = "";
  let i = 0;
  let lastSignificant = "";
  const regexMayFollow = () => lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) ||
    /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw)$/.test(code.trimEnd());
  while (i < src.length) {
    const ch = src[i];
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") {
          value += src[j + 1];
          j += 2;
        } else {
          value += src[j];
          j++;
        }
      }
      strings.push(value);
      code += ch + ch;
      lastSignificant = ch;
      i = j + 1;
    } else if (ch === "/" && regexMayFollow()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && (src[j] !== "/" || inClass)) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      code += "/re/";
      lastSignificant = "/";
      i = j;
    } else {
      code += ch;
      if (!/\s/.test(ch)) lastSignificant = ch;
      i++;
    }
  }
  return { strings, code };
}

const sources = JS_FILES.map((f) => ({ file: f, src: fs.readFileSync(f, "utf8"), ...lex(fs.readFileSync(f, "utf8")) }));
const css = fs.readFileSync(CSS_FILE, "utf8");
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const partial = menuPartial();

describe("conventions: the lexer this suite relies on", () => {
  it("separates strings, comments and regex literals", () => {
    const { strings, code } = lex(`var a = "x'y"; // "not a string"\n/* 'nor this' */ s.replace(/'/g, "&#39;").replace(/"/g, 'q'); var b = c / d / "e";`);
    assert.deepEqual(strings, ["x'y", "&#39;", "q", "e"]);
    assert.doesNotMatch(code, /not a string|nor this/);
  });

  it("finds the files it is meant to check", () => {
    assert.deepEqual(JS_FILES.map((f) => path.basename(f)).sort(), [
      "activity.js", "connection.js", "front_panel.js", "main.js", "pages.js", "prompt_dialog.js", "router.js",
      "store.js", "view_blocks.js",
    ]);
    assert.ok(sources.every((s) => s.strings.length > 5));
  });
});

describe("conventions: UIkit and theme", () => {
  const all = [...sources.map((s) => [rel(s.file), s.src]), [rel(CSS_FILE), css], [rel(PARTIAL), partial]];

  it("uses none of the light-theme utilities that broke the themed surface", () => {
    for (const [name, src] of all) {
      for (const cls of ["uk-table-striped", "uk-background-muted", "uk-card-secondary"]) {
        assert.ok(!src.includes(cls), `${name} uses ${cls}`);
      }
    }
  });

  it("has no inline styles", () => {
    for (const s of sources) {
      for (const str of s.strings) assert.doesNotMatch(str, /\bstyle\s*=/, `${rel(s.file)}: inline style in "${str}"`);
      assert.doesNotMatch(s.code, /\.style\s*(?:\.|\[|=[^=])|cssText/, `${rel(s.file)} sets element styles from script`);
      assert.ok(!s.strings.includes("style"), `${rel(s.file)} sets a style attribute`);
    }
    assert.doesNotMatch(partial, /\sstyle\s*=/i, "the partial has an inline style");
    assert.doesNotMatch(partial, /<style/i);
  });

  it("has no inline event handlers or inline scripts (CSP: script-src 'self')", () => {
    assert.doesNotMatch(partial, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(partial, /<script/i);
    for (const s of sources) {
      for (const str of s.strings) assert.doesNotMatch(str, /\son(click|change|input|submit|key\w+)\s*=/i, `${rel(s.file)}: "${str}"`);
    }
  });

  const NAMED = ["white", "black", "red", "green", "blue", "gray", "grey", "silver", "yellow", "orange", "purple", "navy", "teal", "maroon", "lime", "aqua", "fuchsia", "olive"];
  const colourLiteral = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|(?<![-\\w])(?:${NAMED.join("|")})(?![-\\w])`, "i");

  it("menu.css takes every colour from the app.css tokens", () => {
    const decls = cssNoComments.match(/[\w-]+\s*:[^;{}]+;/g) || [];
    assert.ok(decls.length > 100);
    for (const d of decls) {
      const value = d.slice(d.indexOf(":") + 1);
      assert.doesNotMatch(value, colourLiteral, `colour literal in menu.css: ${d.trim()}`);
    }
    for (const bad of ["color: #fff;", "background: rgba(0, 0, 0, 0.5);", "border: 1px solid white;", "color: red;"]) {
      assert.match(bad.slice(bad.indexOf(":") + 1), colourLiteral, `the check catches ${bad}`);
    }
    const tokens = new Set((cssNoComments.match(/var\(--[\w-]+/g) || []).map((t) => t.slice(4)));
    const appCss = fs.readFileSync(path.join(STATIC, "css/app.css"), "utf8");
    for (const t of tokens) assert.ok(appCss.includes(t + ":"), `menu.css uses ${t}, which app.css does not define`);
  });

  it("scripts hold no colour literals either", () => {
    for (const s of sources) {
      for (const str of s.strings) {
        assert.doesNotMatch(str, /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|\brgba?\(|\bhsla?\(/, `${rel(s.file)}: "${str}"`);
      }
    }
  });

  it("the partial is a static shell that keeps the blueprint's hooks", () => {
    assert.match(partial, /id="menu-panel"/);
    assert.match(partial, /data-panel="menu"/);
    assert.ok(partial.split("\n").length <= 60, "about 60 lines");
    assert.doesNotMatch(partial, /<select|<option|type="checkbox"/, "no mode control");
  });

  it("base.html loads menu.css after app.css and the scripts in dependency order", () => {
    const base = fs.readFileSync(path.join(ROOT, "wlanpi_webui/templates/base.html"), "utf8");
    assert.ok(base.indexOf("css/app.css") < base.indexOf("css/menu.css"));
    const order = ["js/view_blocks.js", "js/menu/connection.js", "js/menu/store.js", "js/menu/router.js", "js/menu/pages.js",
      "js/menu/prompt_dialog.js", "js/menu/activity.js", "js/menu/front_panel.js", "js/menu/main.js"].map((f) => base.indexOf(f));
    assert.ok(order.every((n) => n > 0));
    assert.deepEqual(order, order.slice().sort((a, b) => a - b));
    assert.ok(!base.includes("js/menu.js"), "the old script is gone");
    assert.equal((base.match(/data-nav="menu"/g) || []).length, 2, "nav entries unchanged");
  });
});

describe("conventions: the server owns the menu (3.2)", () => {
  // Every id and label the built-in manifests and the recorded menu define.
  const ids = new Set();
  const labels = new Set();
  const manifestDir = path.resolve(ROOT, "../wlanpi-menud/share/menu.d");
  const sampleMenu = path.resolve(ROOT, "../wlanpi-menud/protocol/samples/frames/s2c/menu.json");
  const haveManifests = fs.existsSync(manifestDir);
  if (haveManifests) {
    for (const f of fs.readdirSync(manifestDir).filter((n) => n.endsWith(".json"))) {
      for (const n of JSON.parse(fs.readFileSync(path.join(manifestDir, f), "utf8")).nodes || []) {
        ids.add(n.id);
        labels.add(n.label);
      }
    }
  }
  if (fs.existsSync(sampleMenu)) {
    for (const n of JSON.parse(fs.readFileSync(sampleMenu, "utf8")).nodes) {
      ids.add(n.id);
      labels.add(n.label);
    }
  }

  // Captions of device.summary fields on the Home device card. They name
  // fields of the `device.summary` topic, not menu nodes, and are never
  // compared with or used to look up a node.
  const DEVICE_CAPTIONS = new Set(["Battery", "Bluetooth", "Profiler"]);

  it("knows the built-in tree", { skip: !haveManifests && "wlanpi-menud checkout not next to this repo" }, () => {
    assert.ok(ids.size >= 60, `ids: ${ids.size}`);
    assert.ok(ids.has("network.interfaces") && labels.has("Interfaces"));
  });

  it("no script holds a built-in node id or label as a string literal", () => {
    assert.ok(ids.size > 0, "node ids to check against");
    for (const s of sources) {
      for (const str of s.strings) {
        assert.ok(!ids.has(str), `${rel(s.file)} hard-codes the node id "${str}"`);
        if (DEVICE_CAPTIONS.has(str)) {
          assert.equal(path.basename(s.file), "pages.js", `"${str}" is only a device card caption`);
          continue;
        }
        assert.ok(!labels.has(str), `${rel(s.file)} hard-codes the menu label "${str}"`);
      }
    }
    for (const id of ids) {
      if (id.includes(".")) assert.ok(!partial.includes(id), `the partial names node ${id}`);
    }
  });

  it("device card captions appear once each, in the device card only", () => {
    const pages = sources.find((s) => path.basename(s.file) === "pages.js");
    for (const cap of DEVICE_CAPTIONS) {
      assert.equal(pages.strings.filter((x) => x === cap).length, 1, cap);
      assert.match(pages.src, new RegExp(`add\\("${cap}",`), `${cap} is an argument to the device card's add()`);
    }
  });

  it("no script compares a node id with a literal or branches on one", () => {
    for (const s of sources) {
      assert.doesNotMatch(s.code, /(?<!typeof )\b(?:node|route|next|n|kid|cur|parent)\.id\s*[!=]==?\s*["'`]|["'`]\s*[!=]==?\s*(?:node|route|next|n|kid|cur|parent)\.id\b/,
        `${rel(s.file)} compares a node id with a literal`);
      assert.doesNotMatch(s.code, /\bnodeId\s*[!=]==?\s*["'`]|\bcase\s+["'`][^:]*:\s*\/\/\s*node/, `${rel(s.file)} branches on a node id`);
      assert.doesNotMatch(s.code, /\b(?:node|route|n)\.label\s*[!=]==?\s*["'`]/, `${rel(s.file)} compares a label with a literal`);
    }
  });

  it("the menu connection never builds nav frames", () => {
    for (const s of sources) {
      assert.ok(!s.strings.includes("nav"), `${rel(s.file)} names the nav frame`);
    }
    for (const s of sources) {
      assert.doesNotMatch(s.src, /type:\s*["']nav["']/, `${rel(s.file)} builds a nav frame`);
      if (path.basename(s.file) !== "front_panel.js") {
        assert.doesNotMatch(s.src, /type:\s*["']input["']/, `${rel(s.file)} builds an input frame; only the pane does`);
      }
    }
    assert.match(sources.find((s) => path.basename(s.file) === "front_panel.js").src, /type:\s*"input"/);
  });
});

describe("conventions: the user picks a destination, never a transport (2.1)", () => {
  const WORDS = /\b(rich|thin|mirror|session)\b/i;
  // A literal reads as copy when it has a space or starts like a sentence;
  // bare lower-case words are protocol values (hello.mode and so on).
  const looksLikeCopy = (str) => /\s/.test(str.trim()) || /^[A-Z][a-z]/.test(str);

  it("no user-visible string names a protocol shape", () => {
    for (const s of sources) {
      for (const str of s.strings) {
        const visible = str.replace(/<[^>]*>/g, " ");
        if (!looksLikeCopy(visible)) continue;
        assert.doesNotMatch(visible, WORDS, `${rel(s.file)}: "${str}"`);
      }
    }
  });

  it("the heuristic catches what it should", () => {
    for (const bad of ["Thin (Private)", "Show panel mirror", "Session revoked", "Mirror", "Active (rich)"]) {
      assert.ok(looksLikeCopy(bad) && WORDS.test(bad), bad);
    }
    for (const fine of ["thin", "rich", "new", "The device has too many menu sessions open."]) {
      assert.ok(!(looksLikeCopy(fine) && WORDS.test(fine)), fine);
    }
  });

  it("nor does the partial, in text or attributes", () => {
    const text = partial.replace(/<[^>]*>/g, " ");
    assert.doesNotMatch(text, WORDS);
    for (const m of partial.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"]*)"/g)) {
      assert.doesNotMatch(m[1], WORDS, m[0]);
    }
    assert.doesNotMatch(text, /\bmode\b/i, '"Mode" is reserved for the device mode');
  });
});

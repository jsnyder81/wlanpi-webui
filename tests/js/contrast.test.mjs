// The zebra-stripe guard: WCAG contrast for every foreground/background pair
// menu.css uses, in both themes, computed from the tokens in app.css.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { STATIC } from "./helpers/harness.mjs";

const appCss = fs.readFileSync(path.join(STATIC, "css/app.css"), "utf8");
const menuCss = fs.readFileSync(path.join(STATIC, "css/menu.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector) {
  const at = appCss.indexOf(selector + " {");
  assert.ok(at >= 0, `app.css has a ${selector} block`);
  const body = appCss.slice(appCss.indexOf("{", at) + 1, appCss.indexOf("}", at));
  const out = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = block(":root");
const dark = { ...light, ...block('[data-theme="dark"]') };
const THEMES = { light, dark };

function resolve(theme, token, depth = 0) {
  assert.ok(depth < 8, `var() cycle at ${token}`);
  const v = theme[token];
  assert.ok(v !== undefined, `token ${token} is not defined in app.css`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  return ref ? resolve(theme, ref[1], depth + 1) : v;
}

function rgb(value) {
  let m = /^#([0-9a-f]{3})$/i.exec(value);
  if (m) return m[1].split("").map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/i.exec(value);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  assert.fail(`cannot read colour "${value}" (opaque hex expected for a contrast pair)`);
}

function luminance([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a, b) {
  const la = luminance(rgb(a));
  const lb = luminance(rgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---- what menu.css actually uses ---------------------------------------------

const rules = [];
for (const m of menuCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = m[1].trim().replace(/\s+/g, " ");
  if (selector.startsWith("@") || /^(from|to|\d+%)$/.test(selector)) continue;
  const decl = {};
  for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) decl[d[1]] = d[2].trim();
  rules.push({ selector, decl });
}

const token = (value) => {
  const m = /var\((--[\w-]+)\)/.exec(value || "");
  return m ? m[1] : null;
};

// The surfaces menu content sits on: the page, cards and rows, and the hover / inset step.
const SURFACES = ["--bg-page", "--bg-surface", "--surface-2"];

const textPairs = new Map(); // "fg on bg" -> [fg, bg, where]
const boundaryPairs = new Map();
const add = (map, fg, bg, where) => {
  const key = `${fg} on ${bg}`;
  if (!map.has(key)) map.set(key, [fg, bg, where]);
};

for (const { selector, decl } of rules) {
  const fg = token(decl.color);
  const bg = token(decl.background) || token(decl["background-color"]);
  if (fg && bg) {
    add(textPairs, fg, bg, selector);
  } else if (fg) {
    // Text colour set on its own: it can sit on any menu surface.
    for (const s of SURFACES) add(textPairs, fg, s, selector);
  } else if (bg && /::-(webkit|moz)-progress/.test(selector)) {
    // A progress fill or track carries no text: it is a graphic, checked
    // against the track it sits in.
    if (bg !== "--surface-2") add(boundaryPairs, bg, "--surface-2", selector);
  } else if (bg && !decl["background-image"]) {
    // A background set on its own carries the default text colours.
    add(textPairs, "--text", bg, selector);
  }
  for (const [prop, value] of Object.entries(decl)) {
    if (!/^border(-(top|right|bottom|left))?(-color)?$/.test(prop)) continue;
    const t = token(value);
    // --border is the hairline between rows and around cards: decoration, not a control boundary.
    if (!t || t === "--border") continue;
    for (const s of SURFACES) add(boundaryPairs, t, s, selector);
  }
}

// Pairs that come from the shared UIkit theming the menu's markup relies on.
const INHERITED_TEXT = [
  ["--text", "--bg-surface", "card body"], ["--text", "--bg-page", "page"], ["--text", "--surface-2", "hover row"],
  ["--text-muted", "--bg-surface", "muted on card"], ["--text-muted", "--bg-page", "muted on page"],
  ["--text-muted", "--surface-2", "muted on hover row"],
  ["--brand-ink", "--bg-surface", "link on card"], ["--brand-ink", "--bg-page", "link on page"],
  ["--brand-contrast", "--brand-ink", "primary button"],
  ["--warn-fg", "--warn-bg", "warning alert"], ["--info-fg", "--info-bg", "info alert"],
  ["--success-fg", "--success-bg", "ok alert"], ["--danger-fg", "--danger-bg", "error alert"],
];
for (const [fg, bg, where] of INHERITED_TEXT) add(textPairs, fg, bg, where);

describe("contrast: tokens", () => {
  it("reads both theme blocks from app.css", () => {
    assert.ok(Object.keys(light).length > 40);
    assert.notEqual(light["--bg-surface"], dark["--bg-surface"]);
    assert.equal(resolve(light, "--ctl-fg"), light["--brand-ink"], "var() references resolve");
  });

  it("computes WCAG ratios correctly", () => {
    assert.equal(Math.round(ratio("#000000", "#ffffff") * 10) / 10, 21);
    assert.equal(ratio("#777777", "#777777"), 1);
    assert.equal(Math.round(ratio("#767676", "#ffffff") * 100) / 100, 4.54);
    assert.ok(ratio("#fff", "#f8f8f8") < 1.1, "white on the light page: the zebra-stripe failure");
  });

  it("finds the pairs menu.css uses", () => {
    assert.ok(rules.length > 120, `rules: ${rules.length}`);
    assert.ok(textPairs.size >= 15, `text pairs: ${textPairs.size}`);
    assert.ok(boundaryPairs.size >= 6, `boundary pairs: ${boundaryPairs.size}`);
    assert.ok(textPairs.has("--bg-surface on --text"), "the inverted selected-row bar is checked");
    assert.ok(boundaryPairs.has("--text-muted on --bg-surface"), "control borders are checked");
  });
});

for (const [name, theme] of Object.entries(THEMES)) {
  describe(`contrast: ${name} theme`, () => {
    it("text pairs meet 4.5:1", () => {
      const failures = [];
      for (const [key, [fg, bg, where]] of textPairs) {
        const r = ratio(resolve(theme, fg), resolve(theme, bg));
        if (r < 4.5) failures.push(`${key} = ${r.toFixed(2)} (${where})`);
      }
      assert.deepEqual(failures, []);
    });

    it("control boundaries meet 3:1 against every menu surface", () => {
      const failures = [];
      for (const [key, [fg, bg, where]] of boundaryPairs) {
        const r = ratio(resolve(theme, fg), resolve(theme, bg));
        if (r < 3) failures.push(`${key} = ${r.toFixed(2)} (${where})`);
      }
      assert.deepEqual(failures, []);
    });

    it("the selected-row bar stands out from the screen behind it by 3:1", () => {
      const bar = rules.find((r) => r.selector.includes(".menu-fp-screen .list-item-selected"));
      const screen = rules.find((r) => r.selector === ".menu-fp-screen");
      assert.ok(bar && screen);
      const r = ratio(resolve(theme, token(bar.decl.background)), resolve(theme, token(screen.decl.background)));
      assert.ok(r >= 3, `bar against screen = ${r.toFixed(2)}`);
      const inner = ratio(resolve(theme, token(bar.decl.color)), resolve(theme, token(bar.decl.background)));
      assert.ok(inner >= 4.5, `text on the bar = ${inner.toFixed(2)}`);
    });

    it("the hairline token would fail as a control boundary, which is why controls do not use it", () => {
      assert.ok(ratio(resolve(theme, "--border"), resolve(theme, "--bg-surface")) < 3);
    });
  });
}

describe("contrast: nothing escapes the check", () => {
  it("bordered controls take their boundary from the control rule, not the hairline", () => {
    const ctl = rules.find((r) => r.selector.split(",").some((x) => x.trim() === ".menu-panel .menu-ctl"));
    assert.ok(ctl, "menu.css has the .menu-ctl boundary rule");
    const t = token(ctl.decl["border-color"]);
    assert.ok(t && t !== "--border" && t !== "--line-strong", `.menu-ctl border is ${t}`);
    // Every default button, input and select the menu draws carries that class.
    const dir = path.join(STATIC, "js/menu");
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f))
      .concat([path.join(STATIC, "../templates/partials/menu.html")]);
    let seen = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/["'][^"'\n]*\buk-(?:button-default|input|select)\b[^"'\n]*["']/g)) {
        seen += 1;
        assert.match(m[0], /\bmenu-ctl\b/, `${path.basename(f)}: ${m[0]} needs the menu-ctl boundary`);
      }
    }
    assert.ok(seen >= 15, `bordered controls found: ${seen}`);
  });

  it("every colour declaration in menu.css is a token, inherit, transparent or currentColor", () => {
    for (const { selector, decl } of rules) {
      for (const [prop, value] of Object.entries(decl)) {
        if (!/^(color|background|background-color|border(-\w+)*-color|outline-color)$/.test(prop)) continue;
        assert.match(value, /^(var\(--[\w-]+\)|inherit|transparent|currentColor)$/, `${selector} { ${prop}: ${value} }`);
      }
    }
  });
});

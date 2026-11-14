/**
 * MenuPages: renderers for the menu page.
 *
 * Each renderer is `render(container, viewModel)` and draws only from the
 * server's `menu` frame, topic data and job results held in MenuStore. This
 * file holds no node ids, labels, ordering or visibility rules.
 *
 *   status bar · sidebar and filter · Home · branch page · action page
 *   (form, run control, result states) · not-available · banners · notices
 *   · status tiles (complications) and their customize page
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./store.js"), require("./router.js"), require("../view_blocks.js"));
  } else {
    root.MenuPages = factory(root.MenuStore, root.MenuRouter, root.ViewBlocks);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Store, Router, ViewBlocks) {
  "use strict";

  var STATUS = Store.STATUS;
  var TYPE = Router.TYPE;
  var ACTION = "data-menu-action";

  // ---------------------------------------------------------------- DOM helpers

  /** h(doc, "a.menu-row", {href: "#x"}, [children | strings]) */
  function h(doc, spec, attrs, children) {
    var parts = spec.split(".");
    var el = doc.createElement(parts[0] || "div");
    if (parts.length > 1) el.className = parts.slice(1).join(" ");
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "text") {
          el.textContent = String(v);
        } else if (k === "hidden" || k === "disabled" || k === "required" || k === "checked" || k === "selected") {
          el[k] = Boolean(v);
        } else {
          el.setAttribute(k, v === true ? "" : String(v));
        }
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    if (children === null || children === undefined || children === false) return;
    if (!Array.isArray(children)) children = [children];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) {
        append(el, c);
      } else if (typeof c === "string" || typeof c === "number") {
        el.appendChild(el.ownerDocument.createTextNode(String(c)));
      } else {
        el.appendChild(c);
      }
    }
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function icon(doc, name) {
    return h(doc, "span.menu-icon", { "uk-icon": "icon: " + name, "aria-hidden": "true" });
  }

  /**
   * Re-render `container` only when `key` changed. Focus that was inside the
   * container is put back on the element carrying the same data-focus-key.
   */
  function patch(container, key, render) {
    if (!container) return false;
    if (container.__menuKey === key) return false;
    var doc = container.ownerDocument;
    var active = doc.activeElement;
    var focusKey = null;
    if (active && active !== doc.body && container.contains(active)) {
      focusKey = active.getAttribute("data-focus-key");
    }
    container.__menuKey = key;
    clear(container);
    render(container);
    if (focusKey) {
      var again = container.querySelector('[data-focus-key="' + focusKey + '"]');
      if (again && !again.disabled && typeof again.focus === "function") again.focus({ preventScroll: true });
    }
    return true;
  }

  // ---------------------------------------------------------------- formatting

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function fmtTime(ms) {
    if (typeof ms !== "number") return "";
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  function fmtIso(iso) {
    var t = Date.parse(iso);
    return isNaN(t) ? "" : fmtTime(t);
  }

  function capitalise(s) {
    s = String(s);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function fmtTemp(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Math.round(v) + " °C";
    var m = /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*C\s*$/i.exec(String(v));
    return m ? Math.round(parseFloat(m[1])) + " °C" : String(v);
  }

  function fmtPercent(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Math.round(v) + " %";
    var m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(String(v));
    return m ? Math.round(parseFloat(m[1])) + " %" : String(v);
  }

  function fmtBattery(b) {
    if (!b || typeof b !== "object" || b.present === false) return null;
    var parts = [];
    if (typeof b.percent === "number") parts.push(Math.round(b.percent) + " %");
    if (b.status) parts.push(String(b.status).toLowerCase());
    return parts.length ? parts.join(" ") : null;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function has(v) {
    return v !== null && v !== undefined && v !== "";
  }

  // ---------------------------------------------------------------- copy

  var ERROR_COPY = {
    FORBIDDEN: "Your account is not allowed to do this.",
    NOT_FOUND: "This item is no longer available.",
    CORE_UNAVAILABLE: "Device services are not responding.",
    TIMEOUT: "This took too long and was stopped.",
  };
  var CORE_DOWN = "Device services are not responding";

  /** { text, detail } for a job or request error. */
  function errorCopy(err) {
    var code = err && err.code;
    var message = (err && err.message) || "";
    if (code === "CONFLICT") return { text: message || "The device is busy.", detail: null };
    if (ERROR_COPY[code]) return { text: ERROR_COPY[code], detail: message && message !== ERROR_COPY[code] ? message : null };
    return { text: "Something went wrong.", detail: message || null };
  }

  /** Banner model for a connection state: { level, text, action } or null. */
  function bannerCopy(conn) {
    if (!conn) return null;
    var retry = { action: "retry-now", label: "Retry now" };
    if (conn.phase === "waiting") {
      var tail = conn.paused || conn.retryInSec === null
        ? " Waiting to retry."
        : " Retrying in " + conn.retryInSec + " s.";
      var lead = "Connection lost.";
      if (conn.reason === "restarting") lead = "The menu service is restarting.";
      if (conn.reason === "busy") lead = "The device has too many menu sessions open.";
      return { level: "warn", text: lead + tail, button: retry };
    }
    if ((conn.phase === "connecting" || conn.phase === "handshaking") && conn.attempt > 0) {
      return { level: "info", text: "Reconnecting…", busy: true };
    }
    if (conn.phase === "terminal") {
      if (conn.reason === "signed-out") {
        return { level: "error", text: "You have been signed out.", link: { href: "/login", label: "Sign in" } };
      }
      if (conn.reason === "refused") {
        return {
          level: "error",
          text: "This address is not allowed to open the device menu. Open the WebUI using the device's own hostname or IP.",
        };
      }
      return { level: "error", text: "This page is out of date.", button: { action: "reload", label: "Reload" } };
    }
    return null;
  }

  var LEVEL_WORD = { info: "Info", warn: "Warning", error: "Error", ok: "OK" };
  var LEVEL_ICON = { info: "info", warn: "warning", error: "close", ok: "check" };
  var LEVEL_ALERT = { info: "uk-alert-primary", warn: "uk-alert-warning", error: "uk-alert-danger", ok: "uk-alert-success" };

  // ---------------------------------------------------------------- status tiles (spec 2.6, 4.5)

  // This surface's display profile.
  var SURFACE = "webui";
  // Status bar: at most this many tiles before the +N chip (spec 4.5).
  var BAR_MAX = 12;
  // Colour is never the only signal: each status has its own word and,
  // where it judges, its own icon. info carries no tag.
  var TILE_WORD = { ok: "OK", info: "", warn: "Warning", error: "Error", off: "Off", unknown: "No reading" };
  var TILE_ICON = { ok: "check", warn: "warning", error: "close" };
  var UNKNOWN_VALUE = "\u2014";
  // Profiles the customize page offers, with the screen each one draws.
  var PROFILE_NAMES = [
    ["webui", "This WebUI (status bar and Home)"],
    ["panel", "Front panel rows"],
    ["panel.strip", "Front panel status line"],
    ["tui", "Terminal menu footer"],
  ];
  // How many tiles each profile's screen fits (spec 4.5, 128 px panel, no alerts).
  var PROFILE_FITS = { webui: BAR_MAX, panel: 7, "panel.strip": 3, tui: 8 };
  var PROFILE_FITS_WHERE = { webui: "the status bar", panel: "the front panel", "panel.strip": "the front panel status line", tui: "the terminal footer" };
  var SHOW_MAX = 24;

  function tileValue(t) {
    return t.status === "unknown" ? UNKNOWN_VALUE : String(has(t.value) ? t.value : UNKNOWN_VALUE);
  }

  function tileTag(doc, status) {
    var word = TILE_WORD[status];
    if (!word) return null;
    return h(doc, "span.menu-tag.menu-tile-tag", { "data-status": status }, [
      TILE_ICON[status] ? icon(doc, TILE_ICON[status]) : null, TILE_ICON[status] ? " " : null, word,
    ]);
  }

  function profileName(surface) {
    for (var i = 0; i < PROFILE_NAMES.length; i++) if (PROFILE_NAMES[i][0] === surface) return PROFILE_NAMES[i][1];
    if (surface === "default") return "Any other screen";
    return surface;
  }

  /** Display name of a show-list entry: catalog title, live label, or the id. */
  function entryTitle(entry, catalog, live) {
    if (Store.isPattern(entry)) {
      var fam = entry.slice(0, -2);
      if (fam === "plugin") return "All plugin tiles";
      if (fam === "local") return "All local tiles";
      if (fam === "wlanpi") return "All built-in tiles";
      return "All tiles under " + fam;
    }
    if (catalog[entry] && catalog[entry].title) return String(catalog[entry].title);
    if (live[entry] && live[entry].label) return String(live[entry].label);
    return entry;
  }

  // ---------------------------------------------------------------- banner

  function renderBanner(el, vm) {
    var b = bannerCopy(vm && vm.conn);
    var key = b ? JSON.stringify(b) : "";
    patch(el, key, function () {
      var doc = el.ownerDocument;
      if (!b) {
        el.hidden = true;
        el.className = "menu-banner";
        return;
      }
      el.hidden = false;
      el.className = "menu-banner uk-alert " + LEVEL_ALERT[b.level];
      el.setAttribute("role", b.level === "error" ? "alert" : "status");
      el.setAttribute("data-level", b.level);
      append(el, [
        h(doc, "span.menu-banner-text", null, [
          icon(doc, b.busy ? "refresh" : LEVEL_ICON[b.level]),
          h(doc, "span", { text: " " + b.text }),
        ]),
        b.button ? h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
          type: "button", "data-menu-action": b.button.action, "data-focus-key": "banner-btn", text: b.button.label,
        }) : null,
        b.link ? h(doc, "a.uk-button.uk-button-default.uk-button-small.menu-ctl", { href: b.link.href, text: b.link.label }) : null,
      ]);
    });
  }

  // ---------------------------------------------------------------- status bar

  function statusBarModel(vm) {
    var d = vm.device;
    var items = [];
    var alerts = Array.isArray(vm.alerts) ? vm.alerts.length : 0;
    if (!d || !Object.keys(d).length) return { loading: true, items: [], alerts: alerts, asOf: null, coreDown: false };
    var coreDown = d.core === "unavailable";
    var tiles = null;
    var more = 0;
    if (coreDown) {
      if (has(d.ip)) items.push({ k: "ip", text: String(d.ip), primary: true });
    } else if (Array.isArray(vm.tiles)) {
      // The webui profile, in order; the hostname stays fixed chrome.
      if (has(d.hostname)) items.push({ k: "host", text: String(d.hostname), primary: true });
      tiles = [];
      for (var i = 0; i < vm.tiles.length && i < BAR_MAX; i++) {
        var t = vm.tiles[i];
        tiles.push({
          k: t.app_id, label: String(t.label || ""), value: tileValue(t), status: t.status,
          short: t.short && t.status !== "unknown" ? String(t.short) : null, detail: t.detail ? String(t.detail) : null,
        });
      }
      more = vm.tiles.length - tiles.length;
    } else {
      if (has(d.hostname)) items.push({ k: "host", text: String(d.hostname), primary: true });
      if (has(d.mode)) items.push({ k: "mode", text: capitalise(d.mode) });
      if (has(d.ip)) items.push({ k: "ip", text: String(d.ip), primary: true });
      var temp = fmtTemp(d.cpu_temp);
      if (temp) items.push({ k: "temp", text: temp });
      var batt = fmtBattery(d.battery);
      if (batt) items.push({ k: "battery", text: "Battery " + batt });
    }
    return {
      loading: false, items: items, tiles: tiles, more: more, alerts: alerts, coreDown: coreDown,
      asOf: vm.stale && vm.asOf ? fmtTime(vm.asOf) : null,
    };
  }

  function barTile(doc, t) {
    var word = TILE_WORD[t.status];
    var tip = t.label + " " + t.value + (word ? " (" + word + ")" : "") + (t.detail ? ": " + t.detail : "");
    return h(doc, "span.menu-sb-item.menu-sb-tile", { "data-field": t.k, "data-status": t.status, title: tip }, [
      TILE_ICON[t.status] ? icon(doc, TILE_ICON[t.status]) : null,
      h(doc, "span.menu-sb-label", { text: t.label }), " ",
      h(doc, "span.menu-sb-value" + (t.short ? ".has-short" : ""), { text: t.value }),
      // The compact form a phone shows instead (CSS picks one).
      t.short ? h(doc, "span.menu-sb-short", { "aria-hidden": "true", text: t.short }) : null,
      word ? h(doc, "span.visually-hidden", { text: " " + word }) : null,
    ]);
  }

  /**
   * vm: { device, alerts, stale, asOf, tiles }. The bar is one link to Home.
   * Null fields are left out rather than shown as dashes. With `tiles` (the
   * server has status tiles) the bar draws them in configured order.
   */
  function renderStatusBar(el, vm) {
    var m = statusBarModel(vm || {});
    patch(el, JSON.stringify(m), function () {
      var doc = el.ownerDocument;
      el.classList.toggle("is-core-down", m.coreDown);
      el.classList.toggle("has-tiles", Boolean(m.tiles));
      if (m.loading) {
        append(el, h(doc, "span.menu-sb-main", { "aria-hidden": "true" }, [
          h(doc, "span.menu-skel.menu-skel-wide"), h(doc, "span.menu-skel"), h(doc, "span.menu-skel.menu-skel-wide"),
        ]));
        append(el, h(doc, "span.visually-hidden", { text: "Device status loading" }));
        return;
      }
      var main = h(doc, "span.menu-sb-main" + (m.tiles ? ".menu-sb-tiles" : ""));
      if (m.coreDown) {
        append(main, h(doc, "span.menu-sb-item.menu-sb-primary.menu-sb-down", { "data-field": "core" }, [
          icon(doc, "close"), " " + CORE_DOWN,
        ]));
      }
      for (var i = 0; i < m.items.length; i++) {
        var it = m.items[i];
        append(main, h(doc, "span.menu-sb-item" + (it.primary ? ".menu-sb-primary" : ".menu-sb-extra"), {
          "data-field": it.k, text: it.text,
        }));
      }
      if (m.tiles) {
        for (var j = 0; j < m.tiles.length; j++) append(main, barTile(doc, m.tiles[j]));
        append(main, h(doc, "span.menu-sb-item.menu-sb-more", {
          "data-field": "more", "data-more": String(m.more), hidden: m.more <= 0,
        }, [h(doc, "span.menu-sb-more-n", { text: "+" + m.more }), h(doc, "span.visually-hidden", { text: " more on Home" })]));
      }
      append(el, main);
      var side = h(doc, "span.menu-sb-side");
      if (m.asOf) append(side, h(doc, "span.menu-sb-asof", { text: "(as of " + m.asOf + ")" }));
      if (m.alerts > 0) {
        append(side, h(doc, "span.menu-sb-alerts", { "data-field": "alerts" }, [
          icon(doc, "warning"), " " + plural(m.alerts, "alert", "alerts"),
        ]));
      }
      append(el, side);
    });
  }

  /**
   * Cut the bar's tiles to what fits on one line: hide tiles from the end
   * and count them into the +N chip (spec 4.5). Never reorders. Without
   * layout (no widths) nothing is cut.
   */
  function fitStatusBar(el) {
    var main = el && el.querySelector(".menu-sb-tiles");
    if (!main) return;
    var tiles = main.querySelectorAll(".menu-sb-tile");
    var more = main.querySelector(".menu-sb-more");
    var base = more ? parseInt(more.getAttribute("data-more"), 10) || 0 : 0;
    var i;
    for (i = 0; i < tiles.length; i++) tiles[i].hidden = false;
    var cut = 0;
    var setMore = function () {
      if (!more) return;
      var n = base + cut;
      more.hidden = n <= 0;
      more.querySelector(".menu-sb-more-n").textContent = "+" + n;
    };
    setMore();
    if (!main.clientWidth) return;
    for (i = tiles.length - 1; i >= 0 && main.scrollWidth > main.clientWidth; i--) {
      tiles[i].hidden = true;
      cut += 1;
      setMore();
    }
  }

  // ---------------------------------------------------------------- rows and trees

  function labelPath(state, id) {
    var path = Store.pathTo(state, id);
    var out = [];
    for (var i = 0; i < path.length; i++) out.push(path[i].label);
    return out.join(" › ");
  }

  function filterNodes(state, text) {
    var q = String(text || "").trim().toLowerCase();
    if (!q || !state.menu) return [];
    var out = [];
    var walk = function (parent) {
      var kids = Store.childrenOf(state, parent);
      for (var i = 0; i < kids.length; i++) {
        if (String(kids[i].label).toLowerCase().indexOf(q) !== -1) out.push(kids[i]);
        if (kids[i].kind === "branch") walk(kids[i].id);
      }
    };
    walk("");
    return out;
  }

  /**
   * A row says what selecting it will do, from fields on the menu node only:
   * child count and chevron for a branch, a trailing ellipsis for parameters,
   * a "changes device" marker (icon and words) for a mutation, a provider tag.
   */
  function rowLink(doc, state, node, opts) {
    opts = opts || {};
    var isBranch = node.kind === "branch";
    var hasParams = Array.isArray(node.params) && node.params.length > 0;
    var cues = h(doc, "span.menu-row-cues");
    if (node.provider) append(cues, h(doc, "span.menu-tag", { text: String(node.provider) }));
    if (!isBranch && Store.isMutating(node)) {
      append(cues, h(doc, "span.menu-row-mutates", null, [icon(doc, "bolt"), " changes device"]));
    }
    if (isBranch) {
      append(cues, h(doc, "span.menu-row-count", { text: plural(Store.childrenOf(state, node.id).length, "item", "items") }));
    }
    append(cues, h(doc, "span.menu-row-chevron", { "uk-icon": "icon: chevron-right", "aria-hidden": "true" }));
    var label = h(doc, "span.menu-row-label", null, [
      h(doc, "span.menu-row-name", { text: node.label + (hasParams ? "…" : "") }),
      opts.path ? h(doc, "span.menu-row-path", { text: opts.path }) : null,
    ]);
    return h(doc, "a.menu-row", {
      href: Router.hrefFor(node.id), "data-node": node.id, "data-kind": node.kind,
      "data-focus-key": "row:" + node.id,
    }, [label, cues]);
  }

  function rowList(doc, state, nodes, opts) {
    var ul = h(doc, "ul.menu-rows");
    for (var i = 0; i < nodes.length; i++) {
      var path = null;
      if (opts && opts.withPath) {
        var parent = nodes[i].parent;
        path = typeof parent === "string" ? labelPath(state, parent) : null;
      }
      append(ul, h(doc, "li", null, rowLink(doc, state, nodes[i], { path: path })));
    }
    return ul;
  }

  // ---------------------------------------------------------------- sidebar

  function treeItems(doc, state, parentId, pathIds, currentId) {
    var kids = Store.childrenOf(state, parentId);
    var out = [];
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      var isCurrent = n.id === currentId;
      var onPath = pathIds.indexOf(n.id) !== -1;
      var a = h(doc, "a", {
        href: Router.hrefFor(n.id), "data-node": n.id, "aria-current": isCurrent ? "page" : null,
        "data-focus-key": "tree:" + n.id, text: n.label,
      });
      var li = h(doc, "li" + (isCurrent ? ".uk-active" : "") + (onPath ? ".menu-tree-open" : ""), null, a);
      if (n.kind === "branch" && onPath) {
        var sub = treeItems(doc, state, n.id, pathIds, currentId);
        if (sub.length) append(li, h(doc, "ul.uk-nav-sub", null, sub));
      }
      out.push(li);
    }
    return out;
  }

  /**
   * vm: { state, route, filter }. A nav landmark of real links: top-level
   * sections, the current path expanded and marked, a filter over labels.
   */
  function renderSidebar(el, vm) {
    var doc = el.ownerDocument;
    var state = vm.state;
    if (!el.__menuBuilt) {
      el.__menuBuilt = true;
      clear(el);
      append(el, [
        h(doc, "div.menu-filter", null, [
          h(doc, "label.visually-hidden", { "for": "menu-filter", text: "Filter menu" }),
          h(doc, "input.uk-input.uk-form-small.menu-ctl", {
            id: "menu-filter", type: "search", placeholder: "Filter…", autocomplete: "off",
            "data-menu-filter": "", "aria-describedby": "menu-filter-hint",
          }),
          h(doc, "span.visually-hidden", { id: "menu-filter-hint", text: "Press slash to jump here" }),
        ]),
        h(doc, "div.menu-tree", { "data-region": "tree" }),
      ]);
    }
    var input = el.querySelector("[data-menu-filter]");
    if (input && input.value !== vm.filter && doc.activeElement !== input) input.value = vm.filter || "";
    var tree = el.querySelector('[data-region="tree"]');
    var route = vm.route;
    var key = JSON.stringify([state.menu ? state.menu.revision : null, route.type, route.id, vm.filter || "",
      state.menu ? Object.keys(state.menu.byId).length : 0]);
    patch(tree, key, function () {
      if (!state.menu) {
        append(tree, h(doc, "div.menu-skel-list", { "aria-hidden": "true" }, [
          h(doc, "span.menu-skel.menu-skel-wide"), h(doc, "span.menu-skel"), h(doc, "span.menu-skel.menu-skel-wide"),
        ]));
        return;
      }
      if (String(vm.filter || "").trim()) {
        var matches = filterNodes(state, vm.filter);
        if (!matches.length) {
          append(tree, h(doc, "p.menu-muted.menu-filter-empty", { text: "No menu items match." }));
          return;
        }
        var ul = h(doc, "ul.uk-nav.uk-nav-default.menu-tree-list");
        for (var i = 0; i < matches.length; i++) {
          var n = matches[i];
          var parentPath = typeof n.parent === "string" ? labelPath(state, n.parent) : "";
          append(ul, h(doc, "li", null, h(doc, "a", {
            href: Router.hrefFor(n.id), "data-node": n.id, "data-focus-key": "tree:" + n.id,
          }, [n.label, parentPath ? h(doc, "span.menu-tree-path", { text: parentPath }) : null])));
        }
        append(tree, ul);
        return;
      }
      var pathIds = [];
      if (route.node) {
        var path = Store.pathTo(state, route.id);
        for (var p = 0; p < path.length; p++) pathIds.push(path[p].id);
      }
      var home = h(doc, "li" + (route.type === TYPE.HOME ? ".uk-active" : ""), null, h(doc, "a", {
        href: Router.hrefFor(""), "aria-current": route.type === TYPE.HOME ? "page" : null,
        "data-focus-key": "tree:", text: "Home",
      }));
      append(tree, h(doc, "ul.uk-nav.uk-nav-default.menu-tree-list", null,
        [home].concat(treeItems(doc, state, "", pathIds, route.id))));
    });
  }

  // ---------------------------------------------------------------- breadcrumb

  function breadcrumb(doc, state, route) {
    var path = route.node ? Store.pathTo(state, route.id) : [];
    var ul = h(doc, "ul.uk-breadcrumb.menu-crumbs-full");
    append(ul, h(doc, "li", null, h(doc, "a", { href: Router.hrefFor(""), text: "Menu" })));
    for (var i = 0; i < path.length; i++) {
      var last = i === path.length - 1;
      append(ul, h(doc, "li", null, last
        ? h(doc, "span", { "aria-current": "page", text: path[i].label })
        : h(doc, "a", { href: Router.hrefFor(path[i].id), text: path[i].label })));
    }
    var parent = path.length > 1 ? path[path.length - 2] : null;
    var back = h(doc, "a.menu-back", { href: Router.hrefFor(parent ? parent.id : "") }, [
      h(doc, "span", { "aria-hidden": "true", text: "‹ " }), parent ? parent.label : "Menu",
    ]);
    return h(doc, "nav.menu-crumbs", { "aria-label": "Breadcrumb" }, [ul, back]);
  }

  function pageTitle(doc, text) {
    return h(doc, "h2.menu-title", { tabindex: "-1", id: "menu-page-title", text: text });
  }

  // ---------------------------------------------------------------- Home

  function deviceFields(d) {
    var f = [];
    var add = function (label, value, primary) {
      if (has(value)) f.push({ label: label, value: String(value), primary: Boolean(primary) });
    };
    add("Hostname", d.hostname);
    add("Model", d.model);
    add("Mode", has(d.mode) ? capitalise(d.mode) : null, true);
    add("Software", d.software_version);
    add("IP", d.ip, true);
    add("Uptime", d.uptime);
    add("eth0", d.eth0);
    add("wlan0", d.wlan0);
    add("CPU", fmtPercent(d.cpu));
    add("Temperature", fmtTemp(d.cpu_temp), true);
    add("Battery", fmtBattery(d.battery), true);
    if (typeof d.bluetooth_on === "boolean") add("Bluetooth", d.bluetooth_on ? "on" : "off");
    if (typeof d.profiler_running === "boolean") add("Profiler", d.profiler_running ? "running" : "stopped");
    if (typeof d.reachable === "boolean") add("Internet", d.reachable ? "reachable" : "not reachable");
    if (Array.isArray(d.wlan_adapters) && d.wlan_adapters.length) add("WLAN adapters", d.wlan_adapters.join(", "));
    if (typeof d.hotspot_clients === "number") add("Hotspot clients", d.hotspot_clients);
    return f;
  }

  function deviceCard(doc, d, expanded) {
    var fields = deviceFields(d || {});
    var dl = h(doc, "dl.menu-device-grid");
    var extras = 0;
    for (var i = 0; i < fields.length; i++) {
      if (!fields[i].primary) extras += 1;
      append(dl, h(doc, "div.menu-device-field" + (fields[i].primary ? "" : ".menu-device-extra"), null, [
        h(doc, "dt", { text: fields[i].label }), h(doc, "dd", { text: fields[i].value }),
      ]));
    }
    var card = h(doc, "section.uk-card.uk-card-default.uk-card-body.uk-card-small.menu-device" + (expanded ? ".is-expanded" : ""), {
      "aria-labelledby": "menu-device-title",
    }, [h(doc, "h3.menu-card-title", { id: "menu-device-title", text: "Device" })]);
    if (!fields.length) {
      append(card, h(doc, "p.menu-muted", { text: "Waiting for device status…" }));
      return card;
    }
    append(card, dl);
    if (extras) {
      append(card, h(doc, "button.uk-button.uk-button-link.menu-device-more", {
        type: "button", "data-menu-action": "device-more", "aria-expanded": expanded ? "true" : "false",
        "data-focus-key": "device-more", text: expanded ? "Less" : "More",
      }));
    }
    return card;
  }

  function alertList(doc, alerts) {
    var ul = h(doc, "ul.menu-alerts", { "aria-label": "Alerts" });
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i] || {};
      var level = LEVEL_WORD[a.level] ? a.level : "info";
      append(ul, h(doc, "li.uk-alert.menu-alert." + LEVEL_ALERT[level], { "data-level": level }, [
        icon(doc, LEVEL_ICON[level]), " ", h(doc, "strong", { text: LEVEL_WORD[level] }), " ", String(a.message || ""),
      ]));
    }
    return ul;
  }

  function complicationList(doc, items) {
    var dl = h(doc, "dl.menu-complications", { "aria-label": "App status" });
    for (var i = 0; i < items.length; i++) {
      var c = items[i] || {};
      append(dl, h(doc, "div.menu-complication", { "data-status": String(c.status || "") }, [
        h(doc, "dt", { text: String(c.label || c.app_id || "") }),
        h(doc, "dd", null, [String(c.value || ""), c.status ? h(doc, "span.menu-tag", { text: String(c.status) }) : null]),
      ]));
    }
    return dl;
  }

  function tileCard(doc, tiles) {
    var card = h(doc, "section.uk-card.uk-card-default.uk-card-body.uk-card-small.menu-tiles", {
      "aria-labelledby": "menu-tiles-title",
    }, [
      h(doc, "div.menu-tiles-head", null, [
        h(doc, "h3.menu-card-title", { id: "menu-tiles-title", text: "Status tiles" }),
        h(doc, "a.uk-button.uk-button-link.menu-tiles-customize", {
          href: Router.hrefFor(Router.TILES_ID), "data-focus-key": "tiles-customize", text: "Customize",
        }),
      ]),
    ]);
    if (!tiles.length) {
      append(card, h(doc, "p.menu-muted", { text: "No tiles are reporting for this screen." }));
      return card;
    }
    var dl = h(doc, "dl.menu-tile-grid");
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      append(dl, h(doc, "div.menu-tile", { "data-status": t.status, "data-tile": t.app_id }, [
        h(doc, "dt", { text: String(t.label || t.app_id) }),
        h(doc, "dd", null, [
          h(doc, "span.menu-tile-value", { text: tileValue(t) }), tileTag(doc, t.status),
          t.detail ? h(doc, "span.menu-tile-detail", { text: String(t.detail) }) : null,
        ]),
      ]));
    }
    append(card, dl);
    return card;
  }

  function renderHome(el, vm) {
    var doc = el.ownerDocument;
    var state = vm.state;
    var d = Store.topic(state, "device.summary") || {};
    var alerts = Store.topic(state, "alerts") || [];
    var comps = Store.topic(state, "complications") || [];
    var tiles = Store.tilesFor(state, SURFACE);
    var coreDown = d.core === "unavailable";

    if (el.__menuPage !== "home") {
      el.__menuPage = "home";
      el.__menuKey = null;
      clear(el);
      append(el, [
        pageTitle(doc, "Home"),
        h(doc, "div.menu-filter.menu-home-filter", null, [
          h(doc, "label.visually-hidden", { "for": "menu-filter-home", text: "Filter menu" }),
          h(doc, "input.uk-input.menu-ctl", {
            id: "menu-filter-home", type: "search", placeholder: "Filter…", autocomplete: "off", "data-menu-filter": "",
          }),
        ]),
        h(doc, "div", { "data-region": "device" }),
        h(doc, "div", { "data-region": "sections" }),
      ]);
    }
    var input = el.querySelector("[data-menu-filter]");
    if (input && input.value !== vm.ui.filter && doc.activeElement !== input) input.value = vm.ui.filter || "";

    var deviceEl = el.querySelector('[data-region="device"]');
    patch(deviceEl, JSON.stringify([d, alerts, tiles || comps, Boolean(tiles), vm.ui.deviceExpanded]), function () {
      if (coreDown) {
        append(deviceEl, h(doc, "div.uk-alert.uk-alert-danger.menu-core-down", { role: "alert" }, [
          icon(doc, "close"), " ", h(doc, "strong", { text: "Error" }), " ",
          CORE_DOWN + ". The menu will work again when they are back.",
        ]));
      }
      append(deviceEl, deviceCard(doc, coreDown ? { ip: d.ip } : d, vm.ui.deviceExpanded));
      if (alerts.length) append(deviceEl, alertList(doc, alerts));
      if (tiles) {
        if (!coreDown) append(deviceEl, tileCard(doc, tiles));
      } else if (comps.length) {
        append(deviceEl, complicationList(doc, comps));
      }
    });

    var sectionsEl = el.querySelector('[data-region="sections"]');
    var filter = String(vm.ui.filter || "").trim();
    patch(sectionsEl, JSON.stringify([state.menu.revision, filter, Object.keys(state.menu.byId).length]), function () {
      if (filter) {
        var matches = filterNodes(state, filter);
        append(sectionsEl, matches.length
          ? rowList(doc, state, matches, { withPath: true })
          : h(doc, "p.menu-muted.menu-filter-empty", { text: "No menu items match." }));
        return;
      }
      var top = Store.childrenOf(state, "");
      var grid = h(doc, "ul.menu-cards", { "aria-label": "Menu sections" });
      for (var i = 0; i < top.length; i++) {
        var n = top[i];
        var isBranch = n.kind === "branch";
        var sub = isBranch
          ? plural(Store.childrenOf(state, n.id).length, "item", "items")
          : (Store.isMutating(n) ? "changes device" : "");
        append(grid, h(doc, "li", null, h(doc, "a.uk-card.uk-card-default.uk-card-body.uk-card-small.menu-card", {
          href: Router.hrefFor(n.id), "data-node": n.id, "data-focus-key": "card:" + n.id,
        }, [
          h(doc, "span.menu-card-label", { text: n.label }),
          sub ? h(doc, "span.menu-card-sub", { text: sub }) : null,
          h(doc, "span.menu-row-chevron", { "uk-icon": "icon: chevron-right", "aria-hidden": "true" }),
        ])));
      }
      append(sectionsEl, grid);
    });
  }

  // ---------------------------------------------------------------- status tiles customize page (spec 4.7)

  /**
   * The show list each profile's screen gets, edited in place. Every change
   * is one complications.configure sent by main.js; this page draws only from
   * the complications.config event, never from its own optimistic state.
   * vm.ui.tilesSurface: the profile being edited.
   */
  function tilesModel(vm) {
    var state = vm.state;
    var surface = vm.ui.tilesSurface || SURFACE;
    var cfg = Store.topic(state, "complications.config");
    var prof = cfg && cfg.surfaces ? cfg.surfaces[surface] || null : null;
    var catalogList = Store.topic(state, "complications.catalog") || [];
    var catalog = {};
    for (var i = 0; i < catalogList.length; i++) if (catalogList[i] && catalogList[i].app_id) catalog[catalogList[i].app_id] = catalogList[i];
    var live = Store.liveTiles(state);
    var show = prof && Array.isArray(prof.show) ? prof.show : [];
    var counts = [];
    Store.resolveTiles(show, Object.keys(live), counts);
    var fits = Object.prototype.hasOwnProperty.call(PROFILE_FITS, surface) ? PROFILE_FITS[surface] : null;

    var shown = [];
    var total = 0;
    var fitAfter = -1;
    for (var k = 0; k < show.length; k++) {
      var e = show[k];
      var pattern = Store.isPattern(e);
      var row = { entry: e, title: entryTitle(e, catalog, live), pattern: pattern };
      if (pattern) {
        row.note = counts[k] ? plural(counts[k], "tile", "tiles") + " reporting" : "none reporting";
      } else if (live[e]) {
        var t = assign1(live[e]);
        row.value = tileValue(t);
        row.status = t.status;
      } else {
        row.note = "not reporting";
      }
      total += counts[k] || 0;
      if (fits !== null && fitAfter === -1 && total >= fits && k < show.length - 1) fitAfter = k;
      shown.push(row);
    }
    var inShow = {};
    for (var s2 = 0; s2 < show.length; s2++) inShow[show[s2]] = true;
    var available = [];
    var ids = Object.keys(catalog);
    for (var lid in live) if (!catalog[lid]) ids.push(lid);
    ids.sort();
    for (var a = 0; a < ids.length; a++) {
      var id = ids[a];
      if (inShow[id]) continue;
      var c = catalog[id] || {};
      var lt = live[id] ? assign1(live[id]) : null;
      var covered = null;
      for (var q = 0; q < show.length && !covered; q++) {
        if (Store.isPattern(show[q]) && id.indexOf(show[q].slice(0, -1)) === 0) covered = "shown by " + entryTitle(show[q], catalog, live);
      }
      available.push({
        entry: id, title: entryTitle(id, catalog, live), description: c.description ? String(c.description) : null,
        value: lt ? tileValue(lt) : null, status: lt ? lt.status : null, note: lt ? null : "not reporting", covered: covered,
      });
    }
    var families = ["plugin.*", "local.*"];
    for (var f = 0; f < families.length; f++) {
      if (!inShow[families[f]]) available.push({ entry: families[f], title: entryTitle(families[f], catalog, live), pattern: true });
    }
    var surfaces = [];
    for (var p = 0; p < PROFILE_NAMES.length; p++) surfaces.push(PROFILE_NAMES[p][0]);
    if (cfg && cfg.surfaces) {
      var extra = Object.keys(cfg.surfaces).sort();
      for (var x = 0; x < extra.length; x++) if (surfaces.indexOf(extra[x]) === -1) surfaces.push(extra[x]);
    }
    return {
      supported: Store.hasTiles(state), ready: Boolean(prof), surface: surface, surfaces: surfaces,
      source: prof ? prof.source : null, shown: shown, available: available, fitAfter: fitAfter, fits: fits,
      full: show.length >= SHOW_MAX, editable: Store.canConfigure(state) && vm.connected,
      allowed: Store.canConfigure(state), busy: Store.configuring(state, surface),
      error: state.tilesError ? errorCopy(state.tilesError) : null,
    };
  }

  function assign1(c) {
    var out = {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
    out.status = Store.tileStatus(c.status);
    return out;
  }

  var SOURCE_COPY = {
    "default": "Using the default list.",
    site: "Using the list set for this site.",
    user: "Customized on this device.",
  };

  /**
   * `disabled`: the account or connection cannot edit. `inert`: this button
   * does nothing right now (top row's Up, a save in flight); it stays
   * focusable (aria-disabled) so keyboard focus survives the redraw.
   */
  function tileButton(doc, action, entry, label, text, disabled, inert) {
    return h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
      type: "button", "data-menu-action": action, "data-entry": entry, "aria-label": label,
      "data-focus-key": action + ":" + entry, disabled: disabled, "aria-disabled": inert && !disabled ? "true" : null, text: text,
    });
  }

  function renderTiles(el, vm) {
    var doc = el.ownerDocument;
    var m = tilesModel(vm);
    if (el.__menuPage !== "tiles") {
      el.__menuPage = "tiles";
      el.__menuKey = null;
    }
    patch(el, JSON.stringify(["tiles", m]), function () {
      append(el, [
        h(doc, "nav.menu-crumbs", { "aria-label": "Breadcrumb" }, h(doc, "ul.uk-breadcrumb.menu-crumbs-full.menu-crumbs-always", null,
          h(doc, "li", null, h(doc, "a", { href: Router.hrefFor(""), text: "Menu" })))),
        pageTitle(doc, "Customize status tiles"),
      ]);
      if (!m.supported) {
        append(el, h(doc, "p", { text: "The device's menu service does not offer status tiles yet." }));
        return;
      }
      append(el, h(doc, "p.menu-muted", {
        text: "Choose which tiles each screen shows and in what order. Each change applies at once; a screen shows as many as fit, from the top.",
      }));
      var picker = h(doc, "div.menu-tiles-picker", null, [
        h(doc, "label.uk-form-label", { "for": "menu-tiles-surface", text: "Editing" }),
        h(doc, "select.uk-select.uk-form-small.menu-ctl", {
          id: "menu-tiles-surface", "data-menu-tiles-surface": "", "data-focus-key": "tiles-surface",
        }, m.surfaces.map(function (sname) {
          return h(doc, "option", { value: sname, selected: sname === m.surface, text: profileName(sname) });
        })),
      ]);
      append(el, picker);
      if (!m.ready) {
        append(el, h(doc, "p.menu-muted", { role: "status", text: "Loading the tile layout…" }));
        return;
      }
      append(el, h(doc, "p.menu-tiles-source", { "data-source": String(m.source || "") }, [
        SOURCE_COPY[m.source] || "", m.busy ? h(doc, "span.menu-tiles-busy", { text: " Saving…" }) : null,
      ]));
      if (!m.allowed) append(el, h(doc, "p.menu-muted", { text: "Your account can view these tiles but not change them." }));
      if (m.error) {
        append(el, h(doc, "div.uk-alert.uk-alert-danger.menu-tiles-error", { role: "alert" }, [
          icon(doc, "close"), " ", m.error.text, m.error.detail ? " " + m.error.detail : "",
        ]));
      }
      var off = !m.editable;
      var busy = m.busy;

      var shownSec = h(doc, "section.menu-tiles-shown", { "aria-labelledby": "menu-tiles-shown-title" },
        h(doc, "h3.menu-card-title", { id: "menu-tiles-shown-title", text: "Shown" }));
      if (!m.shown.length) {
        append(shownSec, h(doc, "p.menu-muted", { text: "Nothing is shown on this screen." }));
      } else {
        var ol = h(doc, "ol.menu-tiles-list");
        for (var i = 0; i < m.shown.length; i++) {
          var r = m.shown[i];
          append(ol, h(doc, "li.menu-tiles-row" + (m.fitAfter !== -1 && i > m.fitAfter ? ".is-over" : ""), {
            "data-entry": r.entry, "data-status": r.status || null,
          }, [
            h(doc, "span.menu-tiles-name", { text: r.title }),
            h(doc, "span.menu-tiles-value", null, r.value
              ? [r.value, tileTag(doc, r.status)]
              : h(doc, "span.menu-muted", { text: r.note })),
            m.fitAfter !== -1 && i > m.fitAfter ? h(doc, "span.visually-hidden", { text: " (does not fit)" }) : null,
            h(doc, "span.menu-tiles-actions", null, [
              tileButton(doc, "tile-up", r.entry, "Move " + r.title + " up", "Up", off, busy || i === 0),
              tileButton(doc, "tile-down", r.entry, "Move " + r.title + " down", "Down", off, busy || i === m.shown.length - 1),
              tileButton(doc, "tile-remove", r.entry, "Remove " + r.title, "Remove", off, busy),
            ]),
          ]));
          if (i === m.fitAfter) {
            append(ol, h(doc, "li.menu-tiles-fit", { "aria-hidden": "true", text: "Fits on " + PROFILE_FITS_WHERE[m.surface] + " above" }));
          }
        }
        append(shownSec, ol);
      }

      var availSec = h(doc, "section.menu-tiles-available", { "aria-labelledby": "menu-tiles-available-title" },
        h(doc, "h3.menu-card-title", { id: "menu-tiles-available-title", text: "Available" }));
      if (!m.available.length) {
        append(availSec, h(doc, "p.menu-muted", { text: "Every tile is shown." }));
      } else {
        var ul = h(doc, "ul.menu-tiles-list");
        for (var j = 0; j < m.available.length; j++) {
          var av = m.available[j];
          append(ul, h(doc, "li.menu-tiles-row", { "data-entry": av.entry, "data-status": av.status || null }, [
            h(doc, "span.menu-tiles-name", { text: av.title }),
            h(doc, "span.menu-tiles-value", null, av.pattern ? null : av.value
              ? [av.value, tileTag(doc, av.status)]
              : h(doc, "span.menu-muted", { text: av.note })),
            av.description || av.covered ? h(doc, "span.menu-tiles-desc", {
              text: [av.description, av.covered ? "(" + av.covered + ")" : null].filter(Boolean).join(" "),
            }) : null,
            h(doc, "span.menu-tiles-actions", null,
              tileButton(doc, "tile-add", av.entry, "Add " + av.title, "Add", off, busy || m.full)),
          ]));
        }
        append(availSec, ul);
      }
      append(el, h(doc, "div.menu-tiles-columns", null, [shownSec, availSec]));
      append(el, h(doc, "p", null, h(doc, "button.uk-button.uk-button-default.menu-ctl", {
        type: "button", "data-menu-action": "tiles-reset", "data-focus-key": "tiles-reset",
        disabled: off, "aria-disabled": !off && (busy || m.source === "default") ? "true" : null, text: "Reset to default",
      })));
    });
  }

  /** The show list after one edit, or null when the edit changes nothing. */
  function editedShow(show, action, entry) {
    var list = Array.isArray(show) ? show.slice() : [];
    var i = list.indexOf(entry);
    if (action === "tile-add") {
      if (i !== -1 || list.length >= SHOW_MAX) return null;
      list.push(entry);
    } else if (action === "tile-remove") {
      if (i === -1) return null;
      list.splice(i, 1);
    } else if (action === "tile-up" || action === "tile-down") {
      var j = action === "tile-up" ? i - 1 : i + 1;
      if (i === -1 || j < 0 || j >= list.length) return null;
      list[i] = list[j];
      list[j] = entry;
    } else {
      return null;
    }
    return list;
  }

  // ---------------------------------------------------------------- branch, not available, loading

  function renderBranch(el, vm) {
    var doc = el.ownerDocument;
    var state = vm.state;
    var node = vm.route.node;
    var key = JSON.stringify(["branch", node.id, state.menu.revision, Object.keys(state.menu.byId).length]);
    if (el.__menuPage === key) return;
    el.__menuPage = key;
    clear(el);
    var kids = Store.childrenOf(state, node.id);
    append(el, [
      breadcrumb(doc, state, vm.route),
      pageTitle(doc, node.label),
      kids.length ? rowList(doc, state, kids) : h(doc, "p.menu-muted", { text: "Nothing here." }),
    ]);
  }

  function renderNotAvailable(el) {
    var doc = el.ownerDocument;
    if (el.__menuPage === "not-available") return;
    el.__menuPage = "not-available";
    clear(el);
    append(el, [
      h(doc, "nav.menu-crumbs", { "aria-label": "Breadcrumb" }, h(doc, "ul.uk-breadcrumb.menu-crumbs-full.menu-crumbs-always", null,
        h(doc, "li", null, h(doc, "a", { href: Router.hrefFor(""), text: "Menu" })))),
      pageTitle(doc, "This item is not available"),
      h(doc, "p", {
        text: "It may be hidden in the current device mode, or your account may not have access to it.",
      }),
      h(doc, "p", null, h(doc, "a.uk-button.uk-button-default.menu-ctl", { href: Router.hrefFor(""), text: "Go to Home" })),
    ]);
  }

  function renderLoading(el) {
    var doc = el.ownerDocument;
    if (el.__menuPage === "loading") return;
    el.__menuPage = "loading";
    clear(el);
    append(el, h(doc, "div.menu-connecting", { role: "status" }, [
      h(doc, "span.menu-spinner", { "aria-hidden": "true" }), " Connecting to the device menu…",
    ]));
  }

  // ---------------------------------------------------------------- forms

  function isRequired(param) {
    return param.required !== false;
  }

  /**
   * One labelled control for a manifest parameter (enum, integer, string,
   * adapter), exactly as the schema defines it. `opts.adapters` is the list of
   * adapter names from device.summary; `opts.prefix` keeps ids unique.
   */
  function buildField(doc, param, opts) {
    opts = opts || {};
    var id = (opts.prefix || "menu-param-") + param.name;
    var required = isRequired(param);
    var control;
    var i;
    if (param.type === "enum") {
      control = h(doc, "select.uk-select.menu-ctl", { id: id, name: param.name, required: required });
      var choices = Array.isArray(param.choices) ? param.choices : [];
      if (!required || param.default === undefined) {
        append(control, h(doc, "option", { value: "", text: required ? "Choose…" : "(none)", selected: param.default === undefined }));
      }
      for (i = 0; i < choices.length; i++) {
        append(control, h(doc, "option", {
          value: String(i), text: String(choices[i].label), selected: param.default !== undefined && choices[i].value === param.default,
        }));
      }
    } else if (param.type === "integer") {
      control = h(doc, "input.uk-input.menu-ctl", {
        id: id, name: param.name, type: "number", inputmode: "numeric", required: required,
        min: typeof param.minimum === "number" ? param.minimum : null,
        max: typeof param.maximum === "number" ? param.maximum : null,
        step: typeof param.step === "number" ? param.step : 1,
        value: typeof param.default === "number" ? param.default : null,
      });
    } else if (param.type === "adapter") {
      var names = param.kind === "ethernet" ? [] : (Array.isArray(opts.adapters) ? opts.adapters : []);
      if (names.length) {
        control = h(doc, "select.uk-select.menu-ctl", { id: id, name: param.name, required: required });
        if (!required) append(control, h(doc, "option", { value: "", text: "Automatic" }));
        for (i = 0; i < names.length; i++) append(control, h(doc, "option", { value: names[i], text: names[i] }));
      } else {
        control = h(doc, "input.uk-input.menu-ctl", {
          id: id, name: param.name, type: "text", required: required, autocomplete: "off",
          autocapitalize: "none", spellcheck: "false", placeholder: required ? null : "Automatic",
        });
      }
    } else {
      control = h(doc, "input.uk-input.menu-ctl", {
        id: id, name: param.name, type: param.secret ? "password" : "text", required: required,
        autocomplete: param.secret ? "new-password" : "off",
        pattern: typeof param.pattern === "string" ? param.pattern : null,
        minlength: typeof param.min_length === "number" ? param.min_length : null,
        maxlength: typeof param.max_length === "number" ? param.max_length : null,
        value: typeof param.default === "string" ? param.default : null,
      });
    }
    control.setAttribute("data-param", param.name);
    control.setAttribute("data-focus-key", "param:" + param.name);
    return h(doc, "div.uk-margin-small.menu-field", null, [
      h(doc, "label.uk-form-label", { "for": id, text: param.label || param.name }),
      h(doc, "div.uk-form-controls", null, control),
    ]);
  }

  /** Read the controls built by buildField. Returns { values } or { invalid: element }. */
  function readFields(container, params) {
    var values = {};
    for (var i = 0; i < params.length; i++) {
      var p = params[i];
      var el = container.querySelector('[data-param="' + p.name + '"]');
      if (!el) continue;
      if (typeof el.checkValidity === "function" && !el.checkValidity()) return { invalid: el };
      var raw = el.value;
      if (raw === "" || raw === null || raw === undefined) {
        if (isRequired(p)) return { invalid: el };
        continue;
      }
      if (p.type === "enum") {
        var choice = (p.choices || [])[parseInt(raw, 10)];
        if (!choice) return { invalid: el };
        values[p.name] = choice.value;
      } else if (p.type === "integer") {
        var n = Number(raw);
        if (!isFinite(n) || Math.floor(n) !== n) return { invalid: el };
        values[p.name] = n;
      } else if (p.type === "adapter") {
        values[p.name] = { iface: String(raw).trim() };
      } else {
        values[p.name] = String(raw);
      }
    }
    return { values: values };
  }

  // ---------------------------------------------------------------- action page

  function runLabel(node) {
    return Array.isArray(node.params) && node.params.length ? "Run" : node.label;
  }

  function idleLine(node) {
    var params = Array.isArray(node.params) ? node.params : [];
    if (params.length) {
      var names = [];
      for (var i = 0; i < params.length; i++) names.push(String(params[i].label || params[i].name).toLowerCase());
      return "Set " + names.join(", ") + " and select Run. Nothing runs until you do.";
    }
    return "Select " + node.label + " to run this. Nothing has been changed.";
  }

  function renderControl(el, vm, node, policy, live) {
    var doc = el.ownerDocument;
    var confirming = vm.ui.confirming === node.id;
    var disabled = Boolean(live) || !vm.connected;
    var mutating = Store.isMutating(node);
    var params = Array.isArray(node.params) ? node.params : [];
    var adapters = (Store.topic(vm.state, "device.summary") || {}).wlan_adapters || [];

    if (policy === "auto") {
      patch(el, "auto", function () { el.hidden = true; });
      return;
    }
    el.hidden = false;

    // The form keeps what the user typed: it is rebuilt only when its definition changes.
    var formKey = JSON.stringify([node.id, params, adapters]);
    if (el.__menuFormKey !== formKey) {
      el.__menuFormKey = formKey;
      el.__menuKey = null;
      clear(el);
      var card = h(doc, "form.uk-card.uk-card-default.uk-card-body.uk-card-small.uk-form-stacked.menu-control", {
        id: "menu-action-form", "data-node": node.id, novalidate: null,
        "aria-label": node.label,
      });
      for (var i = 0; i < params.length; i++) append(card, buildField(doc, params[i], { adapters: adapters }));
      append(card, h(doc, "div.menu-run", { "data-region": "run" }));
      append(el, card);
    }

    var run = el.querySelector('[data-region="run"]');
    var key = JSON.stringify([confirming, disabled, node.confirm || null, node.label, mutating]);
    var changed = patch(run, key, function () {
      if (confirming) {
        var c = node.confirm || {};
        append(run, [
          h(doc, "p.menu-run-text", { id: "menu-confirm-text", text: c.message || "" }),
          h(doc, "div.menu-run-buttons", { role: "group", "aria-labelledby": "menu-confirm-text" }, [
            h(doc, "button.uk-button.uk-button-default.menu-ctl", {
              type: "button", "data-menu-action": "confirm-no", "data-focus-key": "confirm-no",
              text: c.cancel_label || "Cancel",
            }),
            h(doc, "button.uk-button." + (mutating ? "uk-button-danger" : "uk-button-primary"), {
              type: "button", "data-menu-action": "confirm-yes", "data-focus-key": "confirm-yes",
              disabled: !vm.connected, text: c.confirm_label || "Confirm",
            }),
          ]),
        ]);
        return;
      }
      append(run, [
        node.confirm && node.confirm.message ? h(doc, "p.menu-run-text", { text: node.confirm.message }) : h(doc, "span.menu-run-text"),
        h(doc, "div.menu-run-buttons", null, h(doc, "button.uk-button.uk-button-primary", {
          type: "submit", "data-menu-action": "run", "data-focus-key": "run", disabled: disabled, text: runLabel(node),
        })),
      ]);
    });
    if (changed && confirming) {
      // Focus lands on Cancel so Enter never confirms by accident.
      var no = run.querySelector('[data-menu-action="confirm-no"]');
      if (no) no.focus({ preventScroll: true });
    }
  }

  function renderMeta(el, vm, node, policy, entry, live) {
    var doc = el.ownerDocument;
    var data = entry && entry.data;
    var disabled = Boolean(live) || !vm.connected;
    var key = JSON.stringify([policy, data ? data.at : null, data ? data.shared : null, data ? data.cachedAt : null, disabled]);
    patch(el, key, function () {
      if (data) {
        append(el, h(doc, "span.menu-updated", { text: "Updated " + fmtTime(data.at) }));
        if (data.shared && data.cachedAt) {
          append(el, h(doc, "span.menu-shared", { text: "Shared result from " + fmtIso(data.cachedAt) }));
        }
      }
      if (policy === "auto") {
        append(el, h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
          type: "button", "data-menu-action": "refresh", "data-focus-key": "refresh", disabled: disabled, text: "Refresh",
        }));
      }
    });
  }

  function progressCard(doc, node, entry, cancellable) {
    var p = (entry && entry.progress) || {};
    var pct = typeof p.pct === "number" ? Math.max(0, Math.min(100, Math.round(p.pct))) : null;
    var bar = h(doc, "progress.uk-progress.menu-progress", {
      "aria-label": node.label + " progress", max: pct === null ? null : 100, value: pct === null ? null : pct,
    });
    return h(doc, "div.uk-card.uk-card-default.uk-card-body.uk-card-small.menu-running", null, [
      h(doc, "div.menu-running-head", null, [
        h(doc, "span.menu-running-text", { text: p.message || "Working…" }),
        cancellable && entry && entry.jobId ? h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
          type: "button", "data-menu-action": "cancel-job", "data-job": entry.jobId, "data-node": node.id,
          "data-focus-key": "cancel-job", "data-needs-live": "", text: "Cancel",
        }) : null,
      ]),
      h(doc, "div.menu-running-bar", null, [bar, pct === null ? null : h(doc, "span.menu-running-pct", { text: pct + " %" })]),
    ]);
  }

  function renderResult(el, vm, node, policy, entry) {
    var doc = el.ownerDocument;
    var status = entry ? entry.status : "idle";
    var data = entry && entry.data;
    var key = JSON.stringify([
      status, entry ? entry.jobId : null, entry ? entry.at : null, entry ? entry.progress : null,
      entry ? entry.error : null, data ? [data.at, data.pagedAt, data.shown, data.cursor, data.dropped] : null,
      entry ? [entry.paging, entry.pageError] : null, policy,
    ]);
    el.setAttribute("aria-busy", status === STATUS.RUNNING ? "true" : "false");
    el.setAttribute("data-status", status);
    patch(el, key, function () {
      if (status === "idle") {
        if (policy !== "auto") append(el, h(doc, "p.menu-muted.menu-idle", { text: idleLine(node) }));
        return;
      }
      if (status === STATUS.RUNNING) {
        append(el, progressCard(doc, node, entry, Boolean(node.cancellable)));
      }
      if (status === STATUS.ERROR) {
        var copy = errorCopy(entry.error);
        append(el, h(doc, "div.uk-alert.uk-alert-danger.menu-error", { role: "alert", "data-code": (entry.error && entry.error.code) || "" }, [
          h(doc, "div.menu-error-head", null, [
            h(doc, "span", null, [icon(doc, "close"), " ", h(doc, "strong", { text: "Error" }), " ", copy.text]),
            h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
              type: "button", "data-menu-action": "retry", "data-focus-key": "retry", "data-needs-live": "", text: "Try again",
            }),
          ]),
          copy.detail ? h(doc, "details.menu-error-details", null, [
            h(doc, "summary", { text: "Details" }), h(doc, "p", { text: copy.detail }),
          ]) : null,
        ]));
        return;
      }
      if (status === STATUS.CANCELLED) {
        append(el, h(doc, "p.menu-cancelled", null, [
          "Cancelled at " + fmtTime(entry.at) + ".",
          policy === "auto" ? [" ", h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
            type: "button", "data-menu-action": "refresh", "data-focus-key": "run-again", "data-needs-live": "", text: "Run again",
          })] : null,
        ]));
      }
      if (!data) return;
      var card = h(doc, "div.uk-card.uk-card-default.uk-card-body.uk-card-small.menu-result-card" + (status === STATUS.RUNNING ? ".is-busy" : ""));
      if (data.title && data.title !== node.label) append(card, h(doc, "h3.menu-card-title", { text: data.title }));
      if (data.dropped) {
        append(card, h(doc, "p.menu-muted.menu-dropped", {
          text: "The first " + plural(data.dropped, "row was", "rows were") + " dropped to keep this page responsive.",
        }));
      }
      var blocks = h(doc, "div.menu-blocks");
      blocks.innerHTML = ViewBlocks.renderBlocks(data.blocks);
      append(card, blocks);
      if (data.cursor || entry.pageError || data.cursorLost) {
        var foot = h(doc, "div.menu-paging");
        var total = typeof data.total === "number" && data.total > 0 ? data.total : null;
        append(foot, h(doc, "span.menu-paging-count", {
          text: total ? "Showing " + Math.min(data.shown, total) + " of " + total : "Showing " + data.shown,
        }));
        if (entry.pageError) {
          append(foot, h(doc, "span.menu-paging-error", { role: "alert", text: errorCopy(entry.pageError).text }));
        }
        if (data.cursorLost) {
          append(foot, h(doc, "span.menu-muted", { text: "Run again to load the rest." }));
        }
        if (data.cursor) {
          append(foot, h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
            type: "button", "data-menu-action": "load-more", "data-node": node.id, "data-focus-key": "load-more",
            "data-needs-live": "", "data-off": entry.paging || status === STATUS.RUNNING ? "1" : null,
            text: entry.paging ? "Loading…" : "Load more",
          }));
        }
        append(card, foot);
      }
      append(el, card);
      ViewBlocks.mountQrCodes(card);
      fitTables(card);
    });
    // Losing or regaining the connection disables or enables the controls
    // without redrawing the result itself.
    var needLive = el.querySelectorAll("[data-needs-live]");
    for (var i = 0; i < needLive.length; i++) {
      needLive[i].disabled = !vm.connected || needLive[i].getAttribute("data-off") === "1";
    }
  }

  function renderAction(el, vm) {
    var doc = el.ownerDocument;
    var state = vm.state;
    var node = vm.route.node;
    var policy = Store.runPolicy(node);
    var entry = Store.resultFor(state, node.id);
    var live = Store.liveJobFor(state, node.id);
    var skeleton = JSON.stringify(["action", node.id, node.label, policy, Store.isMutating(node),
      labelPath(state, node.id)]);
    if (el.__menuPage !== skeleton) {
      el.__menuPage = skeleton;
      clear(el);
      append(el, [
        breadcrumb(doc, state, vm.route),
        h(doc, "div.menu-title-row", null, [
          pageTitle(doc, node.label),
          h(doc, "div.menu-meta", { "data-region": "meta" }),
        ]),
        Store.isMutating(node) ? h(doc, "p.menu-mutates", null, [icon(doc, "bolt"), " This changes the device."]) : null,
        h(doc, "div", { "data-region": "control" }),
        h(doc, "div.menu-result", { "data-region": "result", id: "menu-result", role: "region", "aria-label": node.label + " result" }),
      ]);
    }
    renderMeta(el.querySelector('[data-region="meta"]'), vm, node, policy, entry, live);
    renderControl(el.querySelector('[data-region="control"]'), vm, node, policy, live);
    renderResult(el.querySelector('[data-region="result"]'), vm, node, policy, entry);
  }

  /**
   * The page region. vm: { state, route, ui: { filter, confirming, deviceExpanded }, connected }
   */
  function renderPage(el, vm) {
    el.setAttribute("data-page", vm.route.type);
    el.setAttribute("data-node", vm.route.id || "");
    switch (vm.route.type) {
      case TYPE.LOADING: renderLoading(el); break;
      case TYPE.HOME: renderHome(el, vm); break;
      case TYPE.BRANCH: renderBranch(el, vm); break;
      case TYPE.ACTION: renderAction(el, vm); break;
      case TYPE.TILES: renderTiles(el, vm); break;
      default: renderNotAvailable(el); break;
    }
    if (el.querySelector("#menu-page-title")) {
      el.setAttribute("aria-labelledby", "menu-page-title");
    } else {
      el.removeAttribute("aria-labelledby");
    }
  }

  // ---------------------------------------------------------------- notices

  /** notices: [{ id, node, label, outcome }] for jobs that finished on another page. */
  function renderNotices(el, notices) {
    patch(el, JSON.stringify(notices || []), function () {
      var doc = el.ownerDocument;
      el.hidden = !(notices && notices.length);
      for (var i = 0; i < (notices || []).length; i++) {
        var n = notices[i];
        var text = n.label + (n.outcome === STATUS.ERROR ? " failed." : n.outcome === STATUS.CANCELLED ? " was cancelled." : " finished.");
        append(el, h(doc, "div.uk-alert.uk-alert-primary.menu-notice", { "data-node": n.node }, [
          h(doc, "span", { text: text + " " }),
          h(doc, "a", { href: Router.hrefFor(n.node), "data-menu-action": "notice-view", "data-notice": n.id, text: "View result" }),
          h(doc, "button.uk-button.uk-button-link.menu-notice-close", {
            type: "button", "data-menu-action": "notice-dismiss", "data-notice": n.id,
            "aria-label": "Dismiss: " + text, text: "✕",
          }),
        ]));
      }
    });
  }

  // ---------------------------------------------------------------- tables on narrow surfaces

  function defaultMeasure(wrapper, table) {
    return table.scrollWidth > wrapper.clientWidth + 1;
  }

  /**
   * Drop table columns by `priority` (highest number first) until the table
   * fits its container, then leave the rest to horizontal scroll. Dropped
   * columns stay reachable through the per-row details expander.
   */
  function fitTables(container, measure) {
    if (!container) return;
    var overflows = measure || defaultMeasure;
    var wrappers = container.querySelectorAll(".block-table");
    for (var w = 0; w < wrappers.length; w++) {
      var wrapper = wrappers[w];
      var table = wrapper.querySelector("table");
      if (!table) continue;
      var i;
      var cells = table.querySelectorAll("[data-col]");
      for (i = 0; i < cells.length; i++) cells[i].hidden = false;
      var details = table.querySelectorAll(".table-detail-row");
      for (i = 0; i < details.length; i++) details[i].parentNode.removeChild(details[i]);
      var buttons = table.querySelectorAll(".table-expander-btn");
      for (i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-expanded", "false");
      var expanders = table.querySelectorAll(".table-expander-cell");
      for (i = 0; i < expanders.length; i++) expanders[i].hidden = true;

      var heads = table.querySelectorAll("thead th[data-col]");
      var droppable = [];
      for (i = 0; i < heads.length; i++) {
        var pr = heads[i].getAttribute("data-priority");
        if (pr !== null && pr !== "") droppable.push({ col: heads[i].getAttribute("data-col"), priority: Number(pr), index: i });
      }
      droppable.sort(function (a, b) { return b.priority - a.priority || b.index - a.index; });
      var visible = heads.length;
      var dropped = 0;
      while (droppable.length && visible > 1 && overflows(wrapper, table)) {
        var victim = droppable.shift();
        var col = table.querySelectorAll('[data-col="' + victim.col + '"]');
        for (i = 0; i < col.length; i++) col[i].hidden = true;
        visible -= 1;
        dropped += 1;
        if (dropped === 1) {
          for (i = 0; i < expanders.length; i++) expanders[i].hidden = false;
        }
      }
      wrapper.setAttribute("data-dropped", String(dropped));
      // What still does not fit scrolls sideways; a scrolling region must be
      // reachable by keyboard.
      if (overflows(wrapper, table)) {
        wrapper.setAttribute("tabindex", "0");
        wrapper.setAttribute("role", "region");
        wrapper.setAttribute("aria-label", "Table, scrolls sideways");
      } else {
        wrapper.removeAttribute("tabindex");
        wrapper.removeAttribute("role");
        wrapper.removeAttribute("aria-label");
      }
    }
  }

  return {
    h: h,
    clear: clear,
    icon: icon,
    patch: patch,
    renderBanner: renderBanner,
    renderStatusBar: renderStatusBar,
    fitStatusBar: fitStatusBar,
    editedShow: editedShow,
    tilesModel: tilesModel,
    SURFACE: SURFACE,
    BAR_MAX: BAR_MAX,
    TILE_WORD: TILE_WORD,
    renderSidebar: renderSidebar,
    renderPage: renderPage,
    renderNotices: renderNotices,
    fitTables: fitTables,
    buildField: buildField,
    readFields: readFields,
    filterNodes: filterNodes,
    labelPath: labelPath,
    errorCopy: errorCopy,
    bannerCopy: bannerCopy,
    fmtTime: fmtTime,
    fmtTemp: fmtTemp,
    fmtBattery: fmtBattery,
    statusBarModel: statusBarModel,
    deviceFields: deviceFields,
    LEVEL_WORD: LEVEL_WORD,
    LEVEL_ICON: LEVEL_ICON,
    LEVEL_ALERT: LEVEL_ALERT,
  };
});

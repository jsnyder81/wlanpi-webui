/**
 * MenuPages: renderers for the menu page.
 *
 * Each renderer is `render(container, viewModel)` and draws only from the
 * server's `menu` frame, topic data and job results held in MenuStore. This
 * file holds no node ids, labels, ordering or visibility rules.
 *
 *   status bar · sidebar and filter · Home · branch page · action page
 *   (form, run control, result states) · not-available · banners · notices
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
    if (coreDown) {
      if (has(d.ip)) items.push({ k: "ip", text: String(d.ip), primary: true });
    } else {
      if (has(d.hostname)) items.push({ k: "host", text: String(d.hostname), primary: true });
      if (has(d.mode)) items.push({ k: "mode", text: capitalise(d.mode) });
      if (has(d.ip)) items.push({ k: "ip", text: String(d.ip), primary: true });
      var temp = fmtTemp(d.cpu_temp);
      if (temp) items.push({ k: "temp", text: temp });
      var batt = fmtBattery(d.battery);
      if (batt) items.push({ k: "battery", text: "Battery " + batt });
    }
    return { loading: false, items: items, alerts: alerts, coreDown: coreDown, asOf: vm.stale && vm.asOf ? fmtTime(vm.asOf) : null };
  }

  /**
   * vm: { device, alerts, stale, asOf }. The bar is one link to Home.
   * Null fields are left out rather than shown as dashes.
   */
  function renderStatusBar(el, vm) {
    var m = statusBarModel(vm || {});
    patch(el, JSON.stringify(m), function () {
      var doc = el.ownerDocument;
      el.classList.toggle("is-core-down", m.coreDown);
      if (m.loading) {
        append(el, h(doc, "span.menu-sb-main", { "aria-hidden": "true" }, [
          h(doc, "span.menu-skel.menu-skel-wide"), h(doc, "span.menu-skel"), h(doc, "span.menu-skel.menu-skel-wide"),
        ]));
        append(el, h(doc, "span.visually-hidden", { text: "Device status loading" }));
        return;
      }
      var main = h(doc, "span.menu-sb-main");
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

  function renderHome(el, vm) {
    var doc = el.ownerDocument;
    var state = vm.state;
    var d = Store.topic(state, "device.summary") || {};
    var alerts = Store.topic(state, "alerts") || [];
    var comps = Store.topic(state, "complications") || [];
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
    patch(deviceEl, JSON.stringify([d, alerts, comps, vm.ui.deviceExpanded]), function () {
      if (coreDown) {
        append(deviceEl, h(doc, "div.uk-alert.uk-alert-danger.menu-core-down", { role: "alert" }, [
          icon(doc, "close"), " ", h(doc, "strong", { text: "Error" }), " ",
          CORE_DOWN + ". The menu will work again when they are back.",
        ]));
      }
      append(deviceEl, deviceCard(doc, coreDown ? { ip: d.ip } : d, vm.ui.deviceExpanded));
      if (alerts.length) append(deviceEl, alertList(doc, alerts));
      if (comps.length) append(deviceEl, complicationList(doc, comps));
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

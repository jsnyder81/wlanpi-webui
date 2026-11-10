/**
 * MenuFrontPanel: the optional "Front panel" pane.
 *
 * Shows the device's default session (what is on the physical display) and
 * the same keys, over its own second connection that exists only while the
 * pane is open. Closing the pane detaches only that connection; a failure
 * here never touches the menu connection.
 *
 * With `preview: true` (/menu?panel=private) the same component is bound to
 * its own independent screen and titled "Panel preview".
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./pages.js"), require("../view_blocks.js"));
  } else {
    root.MenuFrontPanel = factory(root.MenuPages, root.ViewBlocks);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Pages, ViewBlocks) {
  "use strict";

  var h = Pages.h;

  var BLOCKS = ["text", "kv", "table", "list", "qr", "status", "progress", "confirm"];
  var KEYS = ["up", "down", "left", "right", "center", "key1", "key2", "key3"];
  var SCREEN = { rows: 8, cols: 24 };

  // Physical keys in d-pad order. Captions come from the view's `hints`.
  var DPAD = [
    { key: "up", glyph: "▲", name: "Up", area: "up" },
    { key: "left", glyph: "◀", name: "Left", area: "left" },
    { key: "center", glyph: "OK", name: "OK", area: "center" },
    { key: "right", glyph: "▶", name: "Right", area: "right" },
    { key: "down", glyph: "▼", name: "Down", area: "down" },
  ];
  var EXTRA = [
    { key: "key1", glyph: "1", name: "Key 1" },
    { key: "key2", glyph: "2", name: "Key 2" },
    { key: "key3", glyph: "3", name: "Key 3" },
  ];
  var KEYBOARD = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "center", Backspace: "left" };

  var PREF_KEY = "wlanpi-menu-front-panel";
  var NOTICE_KEY = "wlanpi-menu-front-panel-notice";

  /** The hello for the pane's connection. */
  function helloFor(preview) {
    return {
      mode: "thin",
      session: preview ? "new" : "default",
      client: { name: preview ? "wlanpi-webui-panel-preview" : "wlanpi-webui-front-panel" },
      capabilities: { screen: SCREEN, colour: "colour", blocks: BLOCKS, keys: KEYS },
    };
  }

  function drivenText(view) {
    var d = view && view.driven_by;
    if (!d) return "";
    if (d.self) return "You are driving";
    var who = d.principal && d.principal.name ? " (" + d.principal.name + ")" : "";
    return "Driven from " + (d.surface || "another surface") + who;
  }

  function safeGet(storage, key) {
    try {
      return storage ? storage.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }

  function safeSet(storage, key, value) {
    try {
      if (storage) storage.setItem(key, value);
    } catch (e) {
      /* private mode */
    }
  }

  /**
   * @param {Element} mount     the pane element (hidden while closed)
   * @param {object} opts
   *   createConnection({hello, onState, onFrame})  returns a MenuConnection (not started)
   *   preview      true for /menu?panel=private
   *   storage      localStorage-like, remembers the open/closed choice
   *   onChange({open, collapsed})  layout hook for the page
   */
  function create(mount, opts) {
    opts = opts || {};
    var doc = mount.ownerDocument;
    var preview = Boolean(opts.preview);
    var storage = opts.storage || null;
    var title = preview ? "Panel preview" : "Front panel";

    var conn = null;
    var connState = null;
    var view = null;
    var waitingFor = {}; // job id -> name of the principal a shared confirmation waits for
    var open = false;
    var collapsed = false;
    var built = false;

    function changed() {
      if (opts.onChange) opts.onChange({ open: open, collapsed: collapsed });
    }

    function live() {
      return Boolean(connState && connState.phase === "live");
    }

    function keysEnabled() {
      return live() && Boolean(view) && view.answerable !== false;
    }

    function sendKey(key) {
      if (!conn || !keysEnabled()) return false;
      return conn.send({ type: "input", key: key }) !== null;
    }

    // ------------------------------------------------------------ build

    function build() {
      built = true;
      Pages.clear(mount);
      mount.appendChild(h(doc, "div.menu-fp-head", null, [
        h(doc, "h3.menu-fp-title", { id: "menu-fp-title" }, [
          h(doc, "span", { text: title }),
          h(doc, "span.menu-fp-title-view", { "data-region": "title-view" }),
        ]),
        h(doc, "span.menu-fp-indicator", { "data-region": "indicator" }),
        h(doc, "button.uk-button.uk-button-link.menu-fp-btn.menu-fp-collapse", {
          type: "button", "data-fp-action": "collapse", "aria-expanded": "true", "aria-controls": "menu-fp-body",
        }),
        h(doc, "button.uk-button.uk-button-link.menu-fp-btn", {
          type: "button", "data-fp-action": "close", "aria-label": "Close " + title.toLowerCase(), text: "✕",
        }),
      ]));
      mount.appendChild(h(doc, "div.menu-fp-body", { id: "menu-fp-body" }, [
        h(doc, "div", { "data-region": "notice" }),
        h(doc, "div.menu-fp-screen", {
          tabindex: "0", role: "group", "data-region": "screen",
          "aria-label": "Device screen. Arrow keys, Enter and Backspace work while focus is here",
        }),
        h(doc, "p.menu-fp-driven", { "data-region": "driven", hidden: true }),
        h(doc, "p.menu-fp-waiting", { "data-region": "waiting", hidden: true }),
        h(doc, "div", { "data-region": "conn" }),
        h(doc, "div.menu-fp-keys", { "data-region": "keys", role: "group", "aria-label": "Device keys" }),
        h(doc, "p.menu-fp-hint", { text: "Click or tab to the screen to use arrow keys." }),
      ]));
      mount.setAttribute("aria-labelledby", "menu-fp-title");
      mount.addEventListener("click", onClick);
      mount.addEventListener("keydown", onKeydown);
    }

    function region(name) {
      return mount.querySelector('[data-region="' + name + '"]');
    }

    // ------------------------------------------------------------ events

    function onClick(evt) {
      var t = evt.target;
      var keyBtn = t.closest ? t.closest("[data-fp-key]") : null;
      if (keyBtn) {
        sendKey(keyBtn.getAttribute("data-fp-key"));
        return;
      }
      var actionEl = t.closest ? t.closest("[data-fp-action]") : null;
      if (!actionEl) return;
      var action = actionEl.getAttribute("data-fp-action");
      if (action === "close") {
        close();
      } else if (action === "collapse") {
        setCollapsed(!collapsed);
      } else if (action === "retry") {
        if (conn) conn.retryNow();
      } else if (action === "notice-ok") {
        safeSet(storage, NOTICE_KEY, "1");
        render();
      }
    }

    // Arrow keys, Enter and Backspace are captured only while focus is inside
    // the pane; the page keeps normal keyboard behaviour everywhere else.
    function onKeydown(evt) {
      var key = KEYBOARD[evt.key];
      if (!key || evt.altKey || evt.ctrlKey || evt.metaKey) return;
      var t = evt.target;
      var tag = t && t.tagName ? t.tagName.toLowerCase() : "";
      // Enter and Backspace keep their meaning on the pane's own buttons and links.
      if ((evt.key === "Enter" || evt.key === "Backspace") && (tag === "button" || tag === "a" || tag === "input")) return;
      evt.preventDefault();
      sendKey(key);
    }

    // ------------------------------------------------------------ frames

    function onFrame(frame) {
      if (!frame) return;
      if (frame.type === "view") {
        view = frame;
        render();
      } else if (frame.type === "prompt") {
        // Not a dialog here: the view is the single source for what is on
        // screen. Only remember who a shared confirmation is waiting for.
        if (frame.job_id && frame.invoked_by && frame.invoked_by.name) waitingFor[frame.job_id] = frame.invoked_by.name;
      }
    }

    function onState(state) {
      connState = state;
      render();
    }

    // ------------------------------------------------------------ render

    function renderScreen() {
      var screen = region("screen");
      var stale = !live();
      screen.classList.toggle("is-stale", stale && Boolean(view));
      Pages.patch(screen, JSON.stringify([view, live()]), function () {
        if (!view) {
          screen.appendChild(h(doc, "p.menu-fp-empty", { text: live() ? "Waiting for the device screen…" : "Connecting…" }));
          return;
        }
        screen.setAttribute("data-screen", view.screen || "");
        var crumb = Array.isArray(view.breadcrumb) ? view.breadcrumb.join(" › ") : "";
        screen.appendChild(h(doc, "div.menu-fp-screen-head", null, [
          h(doc, "span.menu-fp-screen-title", { text: view.title || "" }),
          crumb && crumb !== view.title ? h(doc, "span.menu-fp-screen-crumb", { text: crumb }) : null,
        ]));
        var blocks = h(doc, "div.menu-fp-blocks");
        blocks.innerHTML = ViewBlocks.renderBlocks(view.blocks, { interactive: false, links: false });
        screen.appendChild(blocks);
        ViewBlocks.mountQrCodes(blocks);
        var page = view.page;
        if (page && typeof page.index === "number" && typeof page.count === "number" && page.count > 1) {
          screen.appendChild(h(doc, "div.menu-fp-pagepos", { text: (page.index + 1) + " / " + page.count }));
        }
      });
    }

    function renderKeys() {
      var keys = region("keys");
      var hints = (view && view.hints) || {};
      var enabled = keysEnabled();
      Pages.patch(keys, JSON.stringify([hints, enabled]), function () {
        var pad = h(doc, "div.menu-fp-dpad");
        var i;
        for (i = 0; i < DPAD.length; i++) {
          var k = DPAD[i];
          var caption = hints[k.key];
          pad.appendChild(h(doc, "button.uk-button.uk-button-default.menu-ctl.menu-fp-key.menu-fp-key-" + k.area, {
            type: "button", "data-fp-key": k.key, disabled: !enabled, "data-focus-key": "fp:" + k.key,
            // The name contains the visible text ("OK Select"), as speech input needs.
            "aria-label": caption ? k.name + " " + caption : k.name,
          }, [
            h(doc, "span.menu-fp-key-glyph", { "aria-hidden": "true", text: k.glyph }),
            caption ? [" ", h(doc, "span.menu-fp-key-caption", { "aria-hidden": "true", text: caption })] : null,
          ]));
        }
        keys.appendChild(pad);
        var extra = h(doc, "div.menu-fp-extra");
        var any = false;
        for (i = 0; i < EXTRA.length; i++) {
          var e = EXTRA[i];
          if (!hints[e.key]) continue;
          any = true;
          extra.appendChild(h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl.menu-fp-key", {
            type: "button", "data-fp-key": e.key, disabled: !enabled, "data-focus-key": "fp:" + e.key,
            "aria-label": e.name + " " + hints[e.key],
          }, [h(doc, "span.menu-fp-key-caption", { "aria-hidden": "true", text: hints[e.key] })]));
        }
        if (any) keys.appendChild(extra);
        if (!enabled) keys.appendChild(h(doc, "p.menu-fp-keys-off", { text: "Keys disabled" }));
      });
    }

    function renderConn() {
      var el = region("conn");
      var b = live() ? null : Pages.bannerCopy(connState);
      var first = !b && !live() && connState && connState.phase !== "idle";
      Pages.patch(el, JSON.stringify([b, first]), function () {
        if (!b) return;
        el.appendChild(h(doc, "div.menu-fp-conn", { role: b.level === "error" ? "alert" : "status", "data-level": b.level }, [
          h(doc, "p", { text: b.text }),
          b.button && b.button.action === "retry-now" ? h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
            type: "button", "data-fp-action": "retry", "data-focus-key": "fp-retry", text: b.button.label,
          }) : null,
          b.link ? h(doc, "a.uk-button.uk-button-default.uk-button-small.menu-ctl", { href: b.link.href, text: b.link.label }) : null,
        ]));
      });
    }

    function render() {
      if (!open) return;
      if (!built) build();
      mount.classList.toggle("is-collapsed", collapsed);

      var indicator = region("indicator");
      var isLive = live();
      Pages.patch(indicator, isLive ? "live" : "offline", function () {
        indicator.setAttribute("data-state", isLive ? "live" : "offline");
        indicator.appendChild(Pages.icon(doc, isLive ? "check" : "warning"));
        indicator.appendChild(doc.createTextNode(isLive ? " live" : " offline"));
      });

      var collapse = mount.querySelector('[data-fp-action="collapse"]');
      collapse.setAttribute("aria-expanded", collapsed ? "false" : "true");
      collapse.setAttribute("aria-label", (collapsed ? "Expand " : "Collapse ") + title.toLowerCase());
      collapse.textContent = collapsed ? "▴" : "▾";
      region("title-view").textContent = collapsed && view && view.title ? " · " + view.title : "";

      var notice = region("notice");
      var showNotice = !preview && safeGet(storage, NOTICE_KEY) !== "1";
      Pages.patch(notice, showNotice ? "1" : "0", function () {
        if (!showNotice) return;
        notice.appendChild(h(doc, "div.uk-alert.uk-alert-primary.menu-fp-notice", null, [
          h(doc, "p", { text: "Buttons here move the device's own screen. Anyone looking at the device sees the same thing." }),
          h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
            type: "button", "data-fp-action": "notice-ok", text: "Got it",
          }),
        ]));
      });

      renderScreen();

      var driven = region("driven");
      var text = preview ? "" : drivenText(view);
      driven.textContent = text;
      driven.hidden = !text;

      var waiting = region("waiting");
      var blocked = Boolean(view) && view.answerable === false;
      if (blocked) {
        var who = (view.job_id && waitingFor[view.job_id]) ||
          (view.driven_by && view.driven_by.principal && view.driven_by.principal.name) || "someone else";
        waiting.textContent = "Waiting for " + who + " to confirm on the device.";
      }
      waiting.hidden = !blocked;

      renderConn();
      renderKeys();
    }

    // ------------------------------------------------------------ open / close

    function openPane(remember) {
      if (open) return;
      open = true;
      view = null;
      connState = null;
      mount.hidden = false;
      if (remember !== false && !preview) safeSet(storage, PREF_KEY, "1");
      conn = opts.createConnection({ hello: helloFor(preview), onState: onState, onFrame: onFrame });
      render();
      conn.start();
      changed();
    }

    /** Close the pane: detaches only the pane's own connection. */
    function close(remember) {
      if (!open) return;
      open = false;
      if (conn) {
        conn.close();
        conn = null;
      }
      connState = null;
      view = null;
      waitingFor = {};
      mount.hidden = true;
      if (remember !== false && !preview) safeSet(storage, PREF_KEY, "0");
      changed();
    }

    function setCollapsed(value) {
      collapsed = Boolean(value);
      render();
      changed();
    }

    return {
      open: openPane,
      close: close,
      toggle: function () {
        if (open) {
          close();
        } else {
          openPane();
        }
      },
      isOpen: function () { return open; },
      isCollapsed: function () { return collapsed; },
      setCollapsed: setCollapsed,
      connection: function () { return conn; },
      getView: function () { return view; },
      /** Whether the remembered choice (or the preview flag) asks for the pane on load. */
      wantsOpen: function () { return preview || safeGet(storage, PREF_KEY) === "1"; },
      title: title,
    };
  }

  return {
    create: create,
    helloFor: helloFor,
    drivenText: drivenText,
    PREF_KEY: PREF_KEY,
    NOTICE_KEY: NOTICE_KEY,
    KEYBOARD: KEYBOARD,
  };
});

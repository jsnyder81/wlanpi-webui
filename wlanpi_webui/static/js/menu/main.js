/**
 * Menu page wiring.
 *
 * One surface at /menu: always a private menu on its own connection. The
 * Front panel pane is an optional second connection. The location is the URL
 * hash; every node is a page; a result is shown on its action's page.
 *
 * Reading is automatic, changing is explicit: an action runs on arrival only
 * when it is read-only, takes no parameters and asks no confirmation.
 * Everything else waits for Run, so a click, a reload or the Back button can
 * never change the device.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./connection.js"), require("./store.js"), require("./router.js"), require("./pages.js"),
      require("./prompt_dialog.js"), require("./activity.js"), require("./front_panel.js"), require("../view_blocks.js")
    );
  } else {
    var api = factory(
      root.MenuConnection, root.MenuStore, root.MenuRouter, root.MenuPages,
      root.MenuPromptDialog, root.MenuActivity, root.MenuFrontPanel, root.ViewBlocks
    );
    root.wlanpiMenu = api;
    api.boot(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (
  MenuConnection, Store, Router, Pages, PromptDialog, Activity, FrontPanel, ViewBlocks
) {
  "use strict";

  var TOPICS = ["device.summary", "alerts", "complications", "jobs"];
  var BLOCKS = ["text", "kv", "table", "list", "qr", "status", "progress", "confirm"];
  var TYPE = Router.TYPE;
  var STATUS = Store.STATUS;
  var MAX_NOTICES = 3;
  // The server keeps a detached private menu for its resume grace (120 s).
  var RESUME_WINDOW_MS = 110000;

  // What survives an in-app page swap, so returning to /menu within the
  // server's grace continues where the user left off.
  var saved = null;

  function wsUrl(win) {
    var loc = win.location;
    return (loc.protocol === "https:" ? "wss:" : "ws:") + "//" + loc.host + "/ui/ws";
  }

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }

  /**
   * @param {object} env
   *   win        window
   *   panel      the #menu-panel element
   *   WebSocket  constructor (defaults to win.WebSocket)
   *   storage    localStorage-like (defaults to win.localStorage)
   *   now, setTimeout, clearTimeout, setInterval, clearInterval, random   injectable for tests
   */
  function createApp(env) {
    var win = env.win;
    var doc = win.document;
    var panel = env.panel;
    var now = env.now || function () { return Date.now(); };
    var WS = env.WebSocket || win.WebSocket;
    var storage = env.storage !== undefined ? env.storage : (function () {
      try {
        return win.localStorage;
      } catch (e) {
        return null;
      }
    })();

    function $(id) {
      return panel.querySelector("#" + id);
    }

    var els = {
      banner: $("menu-banner"),
      statusbar: $("menu-statusbar"),
      activity: $("menu-activity"),
      toggle: $("menu-panel-toggle"),
      notices: $("menu-notices"),
      sidebar: $("menu-sidebar"),
      page: $("menu-page"),
      pane: $("menu-front-panel"),
      dialog: $("menu-dialog"),
      live: $("menu-live"),
    };

    var state = Store.createState();
    var connState = { phase: "idle", reason: null, retryInSec: null, attempt: 0, paused: false };
    var ui = { filter: "", confirming: null, deviceExpanded: false, activityOpen: false, notices: [], noticeSeq: 0 };
    var route = { type: TYPE.LOADING, id: "", node: null };
    var routeKey = null;
    var arrival = false; // the current page has not had its on-arrival run yet
    var focusTitle = false;
    var wasWaiting = false;
    var destroyed = false;
    var resizeTimer = null;

    function timerOpts(o) {
      if (env.setTimeout) o.setTimeout = env.setTimeout;
      if (env.clearTimeout) o.clearTimeout = env.clearTimeout;
      if (env.now) o.now = env.now;
      if (env.random) o.random = env.random;
      return o;
    }

    // An expired login reaches the browser as a failed socket (nginx answers
    // the upgrade with 401). Ask the page route, which redirects to /login.
    function checkSignedOut() {
      if (env.checkSignedOut) return env.checkSignedOut();
      if (typeof win.fetch !== "function") return null;
      return win.fetch(win.location.pathname, {
        method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store",
        headers: { "HX-Request": "true" },
      }).then(function (res) {
        return res.type === "opaqueredirect" || res.status === 401 || res.status === 302;
      });
    }

    function newConnection(o) {
      return new MenuConnection(timerOpts({
        url: wsUrl(win), WebSocket: WS, hello: o.hello, onState: o.onState, onFrame: o.onFrame,
        doc: doc, win: win, checkSignedOut: checkSignedOut,
      }));
    }

    var conn = newConnection({
      hello: { mode: "rich", session: "new", client: { name: "wlanpi-webui" }, capabilities: { blocks: BLOCKS } },
      onState: onConnState,
      onFrame: onFrame,
    });

    var preview = false;
    try {
      preview = new win.URLSearchParams(win.location.search).get("panel") === "private";
    } catch (e) {
      preview = /[?&]panel=private(&|$)/.test(win.location.search || "");
    }

    var frontPanel = FrontPanel.create(els.pane, {
      createConnection: newConnection,
      preview: preview,
      storage: storage,
      onChange: function (s) {
        panel.classList.toggle("has-pane", s.open);
        panel.classList.toggle("has-pane-collapsed", s.open && s.collapsed);
        els.toggle.setAttribute("aria-pressed", s.open ? "true" : "false");
      },
    });
    els.toggle.textContent = frontPanel.title;

    var dialog = PromptDialog.create(els.dialog, {
      now: env.now, setInterval: env.setInterval, clearInterval: env.clearInterval,
      describe: function (nodeId) { return Pages.labelPath(state, nodeId); },
      adapters: function () { return (Store.topic(state, "device.summary") || {}).wlan_adapters || []; },
      onAnswer: function (promptId, payload) {
        var fields = { type: "answer", prompt_id: promptId };
        for (var k in payload) fields[k] = payload[k];
        var id = conn.send(fields);
        if (id === null) {
          dialog.showError("Not connected. Try again when the connection is back.");
          return;
        }
        state = Store.trackRequest(state, { id: id, kind: "answer", promptId: promptId, prompt: state.prompt });
        state = Store.closePrompt(state, promptId);
        render();
      },
      onExpire: function (promptId) {
        state = Store.closePrompt(state, promptId);
        render();
      },
    });

    // ------------------------------------------------------------ helpers

    function connected() {
      return connState.phase === "live";
    }

    function announce(text) {
      if (!els.live) return;
      els.live.textContent = "";
      els.live.textContent = text;
    }

    function labelOf(nodeId) {
      var n = Store.getNode(state, nodeId);
      return n ? n.label : nodeId;
    }

    // ------------------------------------------------------------ requests

    function invoke(node, params, confirmed) {
      var fields = { type: "invoke", node: node.id };
      if (params && Object.keys(params).length) fields.params = params;
      if (confirmed) fields.confirmed = true;
      var id = conn.send(fields);
      if (id === null) return false;
      state = Store.trackRequest(state, { id: id, kind: "invoke", node: node.id });
      return true;
    }

    function subscribe() {
      conn.send({ type: "subscribe", topics: TOPICS });
    }

    /** The on-arrival run: only for read-only actions without parameters or confirmation. */
    function arrive() {
      if (!arrival || !connected()) return;
      if (route.type === TYPE.LOADING) return;
      arrival = false;
      if (route.type !== TYPE.ACTION) return;
      if (Store.runPolicy(route.node) !== "auto") return;
      if (Store.liveJobFor(state, route.id)) return;
      invoke(route.node, null, false);
    }

    function currentForm() {
      return els.page.querySelector("#menu-action-form");
    }

    /** Run pressed (or the form submitted). */
    function runPressed() {
      if (route.type !== TYPE.ACTION || !connected()) return;
      var node = route.node;
      if (Store.liveJobFor(state, node.id)) return;
      var policy = Store.runPolicy(node);
      if (policy === "auto") {
        invoke(node, null, false);
        return;
      }
      var params = Array.isArray(node.params) ? node.params : [];
      var form = currentForm();
      var read = form ? Pages.readFields(form, params) : { values: {} };
      if (read.invalid) {
        if (typeof read.invalid.reportValidity === "function") read.invalid.reportValidity();
        read.invalid.focus();
        return;
      }
      if (policy === "confirm") {
        ui.confirming = node.id;
        return;
      }
      invoke(node, read.values, false);
    }

    function confirmPressed() {
      if (route.type !== TYPE.ACTION || ui.confirming !== route.id || !connected()) return;
      var node = route.node;
      var params = Array.isArray(node.params) ? node.params : [];
      var form = currentForm();
      var read = form ? Pages.readFields(form, params) : { values: {} };
      ui.confirming = null;
      if (read.invalid) return;
      // The confirm text was shown here, so the server need not ask again.
      if (invoke(node, read.values, true)) focusTitle = true;
    }

    function cancelJob(jobId, nodeId) {
      var id = conn.send({ type: "cancel", job_id: jobId });
      if (id !== null) state = Store.trackRequest(state, { id: id, kind: "cancel", node: nodeId, jobId: jobId });
    }

    function loadMore(nodeId) {
      var entry = Store.resultFor(state, nodeId);
      if (!entry || !entry.data || !entry.data.cursor || entry.paging) return;
      var id = conn.send({ type: "page", job_id: entry.data.jobId, cursor: entry.data.cursor });
      if (id !== null) state = Store.trackRequest(state, { id: id, kind: "page", node: nodeId, jobId: entry.data.jobId });
    }

    // ------------------------------------------------------------ frames and state

    function noteJob(prev, frame) {
      var terminal = frame.state === "result" || frame.state === "error" || frame.state === "cancelled";
      if (!terminal) return;
      var pend = prev.pending[frame.id];
      if (pend && pend.kind === "page") return;
      var label = labelOf(frame.node);
      var word = frame.state === "result" ? " finished" : frame.state === "error" ? " failed" : " cancelled";
      announce(label + word);
      if (pend && pend.kind === "cancel") return;
      if (route.id === frame.node && route.type === TYPE.ACTION) return;
      // The user is elsewhere: offer the result instead of moving them.
      ui.noticeSeq += 1;
      ui.notices = ui.notices.filter(function (n) { return n.node !== frame.node; });
      ui.notices.push({ id: "n" + ui.noticeSeq, node: frame.node, label: label, outcome: frame.state });
      if (ui.notices.length > MAX_NOTICES) ui.notices = ui.notices.slice(-MAX_NOTICES);
    }

    function onFrame(frame) {
      if (destroyed) return;
      if (frame.type === "view") return; // not part of this connection
      var prev = state;
      state = Store.applyFrame(state, frame, now());
      if (frame.type === "welcome" && !frame.resumed) {
        subscribe();
        arrival = true; // refresh the current page if it runs on arrival
      } else if (frame.type === "job") {
        noteJob(prev, frame);
      }
      syncRoute();
      render();
    }

    function onConnState(s) {
      if (destroyed) return;
      var before = connState;
      connState = s;
      if (s.phase === "waiting" && before.phase !== "waiting" && !wasWaiting) {
        wasWaiting = true;
        announce("Connection lost");
      } else if (s.phase === "live" && wasWaiting) {
        wasWaiting = false;
        announce("Connected again");
      } else if (s.phase === "terminal" && s.reason === "signed-out") {
        announce("You have been signed out");
      }
      if (s.phase !== "live") ui.confirming = null;
      syncRoute();
      render();
    }

    // ------------------------------------------------------------ routing

    function syncRoute() {
      var hash = win.location.hash;
      var next = Router.resolve(state, hash);
      if (next.type === TYPE.NOT_AVAILABLE && doc.getElementById(next.id)) {
        // An in-page anchor (the skip link), not a menu location.
        if (routeKey !== null) {
          next = Router.resolve(state, Router.hrefFor(route.id));
        } else {
          next = Router.resolve(state, "");
        }
      }
      var key = next.type + ":" + next.id;
      route = next;
      if (key !== routeKey) {
        routeKey = key;
        ui.confirming = null;
        arrival = true;
        ui.notices = ui.notices.filter(function (n) { return n.node !== next.id; });
      }
      arrive();
    }

    function onHashChange() {
      if (destroyed) return;
      var before = routeKey;
      syncRoute();
      if (routeKey !== before) focusTitle = true;
      render();
    }

    // ------------------------------------------------------------ render

    function activityItems() {
      var raw = Store.activity(state);
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var j = raw[i];
        var node = Store.getNode(state, j.node);
        var p = j.progress || {};
        out.push({
          jobId: j.jobId, node: j.node, own: j.own,
          label: node ? Pages.labelPath(state, j.node) : j.node,
          pct: typeof p.pct === "number" ? p.pct : null,
          message: p.message || null,
          cancellable: Boolean(node && node.cancellable),
        });
      }
      return out;
    }

    function render() {
      if (destroyed) return;
      var live = connected();
      var device = state.topics["device.summary"];
      panel.classList.toggle("is-stale", !live && Boolean(state.menu));
      panel.setAttribute("data-connection", connState.phase);

      Pages.renderBanner(els.banner, { conn: connState });
      Pages.renderStatusBar(els.statusbar, {
        device: device ? device.data : null,
        alerts: Store.topic(state, "alerts"),
        stale: !live && Boolean(state.menu),
        asOf: device ? device.at : null,
      });
      var items = activityItems();
      if (!items.length) ui.activityOpen = false;
      Activity.render(els.activity, { items: items, open: ui.activityOpen, connected: live });
      Pages.renderNotices(els.notices, ui.notices);
      Pages.renderSidebar(els.sidebar, { state: state, route: route, filter: ui.filter });
      Pages.renderPage(els.page, { state: state, route: route, ui: ui, connected: live });

      if (state.prompt) {
        if (dialog.currentId() !== state.prompt.prompt_id) dialog.show(state.prompt);
        dialog.showError(state.promptError ? Pages.errorCopy(state.promptError).detail || Pages.errorCopy(state.promptError).text : "");
      } else if (dialog.isOpen()) {
        dialog.close();
      }

      if (focusTitle && route.type !== TYPE.LOADING) {
        focusTitle = false;
        var title = els.page.querySelector("#menu-page-title");
        if (title) title.focus({ preventScroll: false });
      }
    }

    // ------------------------------------------------------------ events

    function actionTarget(evt) {
      var t = evt.target;
      return t && t.closest ? t.closest("[data-menu-action]") : null;
    }

    function onClick(evt) {
      if (ViewBlocks.handleClick(evt)) return;
      var el = actionTarget(evt);
      if (!el) {
        if (ui.activityOpen && !(evt.target.closest && evt.target.closest("#menu-activity"))) {
          ui.activityOpen = false;
          render();
        }
        return;
      }
      if (el.disabled) return;
      var action = el.getAttribute("data-menu-action");
      var refocus = null;
      switch (action) {
        case "run":
          return; // a submit button: handled by the form's submit event
        case "refresh":
        case "retry":
          runPressed();
          break;
        case "confirm-yes":
          confirmPressed();
          break;
        case "confirm-no":
          ui.confirming = null;
          refocus = '[data-menu-action="run"]';
          break;
        case "cancel-job":
          cancelJob(el.getAttribute("data-job"), el.getAttribute("data-node"));
          break;
        case "load-more":
          loadMore(el.getAttribute("data-node"));
          break;
        case "retry-now":
          conn.retryNow();
          break;
        case "reload":
          win.location.reload();
          return;
        case "device-more":
          ui.deviceExpanded = !ui.deviceExpanded;
          break;
        case "activity-toggle":
          ui.activityOpen = !ui.activityOpen;
          break;
        case "activity-open":
          ui.activityOpen = false;
          break;
        case "notice-view":
        case "notice-dismiss":
          ui.notices = ui.notices.filter(function (n) { return n.id !== el.getAttribute("data-notice"); });
          break;
        case "panel-toggle":
          frontPanel.toggle();
          break;
        default:
          return;
      }
      render();
      if (refocus) {
        var target = els.page.querySelector(refocus);
        if (target) target.focus();
      }
    }

    function onSubmit(evt) {
      var form = evt.target;
      if (!form || form.id !== "menu-action-form") return;
      evt.preventDefault();
      runPressed();
      render();
    }

    function onInput(evt) {
      var t = evt.target;
      if (!t || !t.hasAttribute || !t.hasAttribute("data-menu-filter")) return;
      ui.filter = t.value;
      render();
    }

    function onKeydown(evt) {
      if (evt.key === "Escape" && ui.activityOpen) {
        ui.activityOpen = false;
        render();
        var chip = els.activity.querySelector('[data-menu-action="activity-toggle"]');
        if (chip) chip.focus();
        return;
      }
      if (evt.key !== "/" || evt.ctrlKey || evt.metaKey || evt.altKey) return;
      var t = evt.target;
      if (isEditable(t) || (t && t.closest && t.closest("#menu-front-panel, #menu-dialog"))) return;
      var inputs = panel.querySelectorAll("[data-menu-filter]");
      if (!inputs.length) return;
      var pick = inputs[0];
      for (var i = 0; i < inputs.length; i++) {
        // The sidebar filter on wide screens, the Home filter on phones.
        if (typeof inputs[i].getClientRects === "function" && inputs[i].getClientRects().length > 0) {
          pick = inputs[i];
          break;
        }
      }
      evt.preventDefault();
      pick.focus();
    }

    function onResize() {
      if (resizeTimer !== null) win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(function () {
        resizeTimer = null;
        if (!destroyed) Pages.fitTables(els.page);
      }, 100);
    }

    // ------------------------------------------------------------ lifecycle

    var stopRouting = Router.subscribe(win, onHashChange);
    panel.addEventListener("click", onClick);
    panel.addEventListener("submit", onSubmit);
    panel.addEventListener("input", onInput);
    doc.addEventListener("keydown", onKeydown);
    win.addEventListener("resize", onResize);

    if (saved && now() - saved.at < RESUME_WINDOW_MS && saved.resume) {
      state = saved.state;
      conn.setResume(saved.resume);
    }
    saved = null;

    syncRoute();
    render();
    conn.start();
    if (frontPanel.wantsOpen()) frontPanel.open(false);

    /** Leave the page: close both connections (1000) and keep what a return can resume. */
    function teardown(keep) {
      if (destroyed) return;
      destroyed = true;
      if (keep !== false && conn.getResume() && connState.phase !== "terminal") {
        saved = { state: state, resume: conn.getResume(), at: now() };
      }
      stopRouting();
      panel.removeEventListener("click", onClick);
      panel.removeEventListener("submit", onSubmit);
      panel.removeEventListener("input", onInput);
      doc.removeEventListener("keydown", onKeydown);
      win.removeEventListener("resize", onResize);
      if (resizeTimer !== null) win.clearTimeout(resizeTimer);
      dialog.close();
      frontPanel.close(false);
      conn.close();
    }

    return {
      panel: panel,
      teardown: teardown,
      getState: function () { return state; },
      getRoute: function () { return route; },
      getConnectionState: function () { return connState; },
      connections: function () {
        return { menu: conn, frontPanel: frontPanel.connection() };
      },
      frontPanel: frontPanel,
      render: render,
    };
  }

  // ---------------------------------------------------------------- page lifecycle

  var app = null;

  /** Start on the page that holds #menu-panel; stop when it is swapped out. */
  function sync(win) {
    var panel = win.document.getElementById("menu-panel");
    if (app && app.panel !== panel) {
      app.teardown();
      app = null;
    }
    if (panel && !app) app = createApp({ win: win, panel: panel });
    return app;
  }

  function boot(win) {
    if (!win || !win.document || typeof win.document.addEventListener !== "function") return;
    var doc = win.document;
    doc.addEventListener("htmx:after:swap", function () { sync(win); });
    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", function () { sync(win); });
    } else {
      sync(win);
    }
  }

  return {
    createApp: createApp,
    boot: boot,
    sync: sync,
    TOPICS: TOPICS,
    // For tests and automation.
    getState: function () { return app ? app.getState() : null; },
    getRoute: function () { return app ? app.getRoute() : null; },
    connections: function () { return app ? app.connections() : { menu: null, frontPanel: null }; },
    connectionState: function () { return app ? app.getConnectionState() : null; },
    current: function () { return app; },
    forgetSaved: function () { saved = null; },
  };
});

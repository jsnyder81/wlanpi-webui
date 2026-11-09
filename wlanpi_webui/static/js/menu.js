/**
 * Menu Panel client for WLAN Pi WebUI.
 *
 * Implements:
 * - Rich mode (session=new by default) with hierarchical menu tree navigation,
 *   action invocation, parameter forms, prompt widgets, job progress with cancel,
 *   and paged results with 'More' fetching.
 * - Mirror panel toggle (thin mode attach to default session) with live server-pushed
 *   view blocks and virtual D-Pad (Up, Down, Left, Right, Center) input forwarding.
 */
(function () {
  "use strict";

  var ws = null;
  var currentMode = "rich"; // "rich" or "thin"
  var currentSession = "new"; // "new" or "default"
  var msgSeq = 0;
  var activeJobs = {}; // job_id -> { node, state, cursor, blocks }
  var menuNodes = [];
  var menuById = {};
  var currentBranchId = null; // null = root
  var activePrompt = null;
  var lastThinView = null;
  var reconnectTimer = null;
  var isManualClose = false;
  var consecutiveAbnormalCloses = 0;
  var reconnectDelay = 2000;
  var MAX_RECONNECT_DELAY = 60000;

  function nextId(prefix) {
    msgSeq++;
    return (prefix || "m") + ":" + msgSeq + ":" + Math.random().toString(36).slice(2, 6);
  }

  function getWsUrl() {
    var loc = window.location;
    var proto = loc.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + loc.host + "/ui/ws";
  }

  function setStatus(text, badgeClass) {
    var el = document.getElementById("menu-connection-status");
    if (!el) return;
    el.textContent = text;
    el.className = "uk-badge " + (badgeClass || "uk-badge-secondary");
  }

  function showMenuUnavailable(msg, showRetry) {
    var text = msg || "Menu unavailable.";
    var retryHtml = showRetry
      ? '<div class="uk-margin-small-top"><button type="button" class="uk-button uk-button-default uk-button-small menu-retry-btn"><span uk-icon="icon: refresh"></span> Retry</button></div>'
      : "";
    var richItems = document.getElementById("rich-menu-items");
    if (richItems) {
      richItems.innerHTML = '<div class="uk-alert uk-alert-warning uk-margin-top uk-text-center"><p>' + text + '</p>' + retryHtml + '</div>';
    }
    var mirrorBlocks = document.getElementById("mirror-screen-blocks");
    if (mirrorBlocks) {
      mirrorBlocks.innerHTML = '<div class="uk-text-center uk-text-muted uk-margin-medium-top"><p>' + text + '</p>' + retryHtml + '</div>';
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Lifecycle
  // ---------------------------------------------------------------------------

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    clearTimeout(reconnectTimer);
    isManualClose = false;
    setStatus("Connecting...", "uk-badge-warning");

    try {
      ws = new WebSocket(getWsUrl());
    } catch (e) {
      setStatus("Error", "uk-badge-danger");
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      setStatus("Connected (" + currentMode + ")", "uk-badge-success");
      sendHello();
    };

    ws.onmessage = function (evt) {
      try {
        var frame = JSON.parse(evt.data);
        consecutiveAbnormalCloses = 0;
        reconnectDelay = 2000;
        handleFrame(frame);
      } catch (err) {
        console.error("[menu] failed to parse frame:", err, evt.data);
      }
    };

    ws.onclose = function (evt) {
      console.log("[menu] ws closed, code:", evt.code, "reason:", evt.reason);
      if (evt.code === 4401) {
        setStatus("Session Revoked", "uk-badge-danger");
        showToast("Authentication expired or session revoked. Please sign in again.", "danger");
        return;
      }
      if (evt.code === 1008) {
        setStatus("Forbidden", "uk-badge-danger");
        showToast("Menu connection forbidden (origin mismatch or policy violation).", "danger");
        showMenuUnavailable("Menu unavailable (policy violation / origin mismatch).", false);
        return;
      }
      if (evt.code === 1006) {
        consecutiveAbnormalCloses++;
        if (consecutiveAbnormalCloses >= 2) {
          console.warn("[menu] consecutive abnormal closes (code 1006), backing off with retry option");
          setStatus("Unavailable", "uk-badge-danger");
          showToast("Menu unavailable.", "danger");
          showMenuUnavailable("Menu unavailable.", true);
        }
      } else {
        consecutiveAbnormalCloses = 0;
        reconnectDelay = 2000;
      }
      if (consecutiveAbnormalCloses < 2) {
        setStatus("Disconnected", "uk-badge-danger");
      }
      if (!isManualClose) {
        scheduleReconnect();
      }
    };

    ws.onerror = function () {
      setStatus("Connection error", "uk-badge-danger");
    };
  }

  function disconnect() {
    isManualClose = true;
    consecutiveAbnormalCloses = 0;
    reconnectDelay = 2000;
    clearTimeout(reconnectTimer);
    if (ws) {
      try {
        ws.close(1000, "client switch");
      } catch (e) {}
      ws = null;
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    var delay = reconnectDelay;
    reconnectTimer = setTimeout(function () {
      var panel = document.getElementById("menu-panel");
      if (panel) {
        connect();
      }
    }, delay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  function retryConnect() {
    clearTimeout(reconnectTimer);
    reconnectDelay = 2000;
    consecutiveAbnormalCloses = 0;
    connect();
  }

  function sendFrame(frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showToast("Cannot send frame: not connected", "warning");
      return;
    }
    ws.send(JSON.stringify(frame));
  }

  function sendHello() {
    var id = nextId("h");
    var helloFrame = {
      v: 1,
      type: "hello",
      id: id,
      mode: currentMode,
      session: currentSession,
      protocol: [1],
      client: {
        name: "wlanpi-webui",
      },
      capabilities: {
        blocks: ["text", "kv", "table", "list", "qr", "status", "progress", "confirm"],
        screen: { rows: 8, cols: 24 },
      },
    };
    sendFrame(helloFrame);
  }

  // ---------------------------------------------------------------------------
  // Frame Dispatcher
  // ---------------------------------------------------------------------------

  function handleFrame(frame) {
    if (!frame || frame.v !== 1) return;

    switch (frame.type) {
      case "welcome":
        onWelcome(frame);
        break;
      case "menu":
        onMenu(frame);
        break;
      case "view":
        onView(frame);
        break;
      case "job":
        onJob(frame);
        break;
      case "prompt":
        onPrompt(frame);
        break;
      case "error":
        onError(frame);
        break;
      default:
        console.log("[menu] unhandled frame:", frame);
    }
  }

  function onWelcome(frame) {
    console.log("[menu] welcome frame:", frame);
    setStatus("Active (" + frame.mode + ")", "uk-badge-success");
    var modeBadge = document.getElementById("menu-session-kind");
    if (modeBadge) {
      modeBadge.textContent = frame.session === "default" ? "Mirror (Shared)" : "Rich (Private)";
    }
  }

  function onMenu(frame) {
    menuNodes = Array.isArray(frame.nodes) ? frame.nodes : [];
    menuById = {};
    for (var i = 0; i < menuNodes.length; i++) {
      var n = menuNodes[i];
      menuById[n.id] = n;
    }
    if (currentMode === "rich") {
      renderRichMenuTree();
    }
  }

  function onView(frame) {
    lastThinView = frame;
    if (currentMode === "thin") {
      renderMirrorView(frame);
    }
  }

  function onJob(frame) {
    var jobId = frame.job_id;
    if (!jobId) return;

    var job = activeJobs[jobId] || {
      job_id: jobId,
      node: frame.node,
      blocks: [],
      cursor: null,
    };
    job.state = frame.state;

    if (frame.state === "result") {
      var res = frame.result || {};
      var newBlocks = Array.isArray(res.blocks) ? res.blocks : [];
      if (frame.id && frame.id.indexOf("page:") === 0) {
        // Appending page results
        job.blocks = (job.blocks || []).concat(newBlocks);
      } else {
        job.blocks = newBlocks;
      }
      job.cursor = res.cursor || null;
      job.title = res.title || "";
    } else if (frame.state === "progress") {
      job.progress = frame.progress || {};
    } else if (frame.state === "error") {
      job.error = frame.error || "Job failed";
    }

    activeJobs[jobId] = job;
    renderJobCard(job);
  }

  function onPrompt(frame) {
    activePrompt = frame;
    renderPrompt(frame);
  }

  function onError(frame) {
    console.error("[menu] server error:", frame);
    showToast("[" + (frame.code || "ERROR") + "] " + (frame.message || "Operation failed"), "danger");
  }

  // ---------------------------------------------------------------------------
  // Rich Mode: Tree Navigation & Action Invocation
  // ---------------------------------------------------------------------------

  function getChildren(parentId) {
    return menuNodes
      .filter(function (n) {
        return (n.parent || null) === parentId;
      })
      .sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
  }

  function renderRichMenuTree() {
    var container = document.getElementById("rich-menu-items");
    var breadcrumbEl = document.getElementById("rich-menu-breadcrumbs");
    if (!container) return;

    // Breadcrumbs
    if (breadcrumbEl) {
      var crumbs = ['<li><a href="#" class="bc-link" data-id="">Menu</a></li>'];
      var path = [];
      var curr = currentBranchId ? menuById[currentBranchId] : null;
      while (curr) {
        path.unshift(curr);
        curr = curr.parent ? menuById[curr.parent] : null;
      }
      for (var p = 0; p < path.length; p++) {
        var node = path[p];
        if (p === path.length - 1) {
          crumbs.push("<li><span>" + window.ViewBlocks.escapeHtml(node.label || node.id) + "</span></li>");
        } else {
          crumbs.push('<li><a href="#" class="bc-link" data-id="' + window.ViewBlocks.escapeAttr(node.id) + '">' + window.ViewBlocks.escapeHtml(node.label || node.id) + "</a></li>");
        }
      }
      breadcrumbEl.innerHTML = crumbs.join("");
    }

    var items = getChildren(currentBranchId);
    if (items.length === 0) {
      container.innerHTML = '<div class="uk-alert uk-alert-warning"><p>No menu items available in this section.</p></div>';
      return;
    }

    var html = '<div class="uk-grid-small uk-child-width-1-1 uk-grid" uk-grid>';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var isBranch = item.kind === "branch" || !item.action;
      var icon = isBranch ? "folder" : (item.mutates ? "bolt" : "play");
      var badge = isBranch ? "Submenu" : (item.view ? item.view.toUpperCase() : "Action");

      html += '<div><div class="uk-card uk-card-default uk-card-small uk-card-body uk-card-hover uk-border-rounded menu-node-card" style="cursor:pointer;" data-node-id="' + window.ViewBlocks.escapeAttr(item.id) + '" data-is-branch="' + (isBranch ? "1" : "0") + '">';
      html += '<div class="uk-flex uk-flex-between uk-flex-middle">';
      html += '<div class="uk-flex uk-flex-middle" style="gap:10px;">';
      html += '<span uk-icon="icon: ' + icon + '; ratio: 1.2;" class="' + (isBranch ? "uk-text-primary" : "uk-text-secondary") + '"></span>';
      html += '<div><div class="uk-text-bold">' + window.ViewBlocks.escapeHtml(item.label || item.id) + "</div>";
      if (item.action && item.action.core) {
        html += '<div class="uk-text-muted uk-text-small">' + window.ViewBlocks.escapeHtml(item.action.core) + "</div>";
      }
      html += "</div></div>";
      html += '<div><span class="uk-badge">' + badge + "</span></div>";
      html += "</div></div></div>";
    }
    html += "</div>";
    container.innerHTML = html;
  }

  function handleNodeClick(nodeId, isBranch) {
    var node = menuById[nodeId];
    if (!node) return;

    if (isBranch) {
      currentBranchId = nodeId;
      renderRichMenuTree();
      return;
    }

    // Action node selected
    selectActionNode(node);
  }

  function selectActionNode(node) {
    var detailEl = document.getElementById("rich-action-detail");
    if (!detailEl) return;

    detailEl.style.display = "block";
    var html = '<div class="uk-card uk-card-default uk-card-body uk-border-rounded uk-margin-small-bottom">';
    html += '<div class="uk-flex uk-flex-between uk-flex-middle uk-margin-small-bottom">';
    html += '<h3 class="uk-card-title uk-margin-remove">' + window.ViewBlocks.escapeHtml(node.label || node.id) + "</h3>";
    html += '<button type="button" class="uk-close uk-icon" id="close-action-detail" uk-close></button>';
    html += "</div>";

    if (node.mutates) {
      html += '<div class="uk-alert uk-alert-warning uk-padding-small"><span uk-icon="icon: warning"></span> This action mutates device state.</div>';
    }

    var params = Array.isArray(node.params) ? node.params : [];
    if (params.length > 0) {
      html += '<form id="action-params-form" class="uk-form-stacked uk-margin-small-top">';
      for (var p = 0; p < params.length; p++) {
        var param = params[p];
        var name = window.ViewBlocks.escapeAttr(param.name);
        var label = window.ViewBlocks.escapeHtml(param.label || param.name);
        html += '<div class="uk-margin-small">';
        html += '<label class="uk-form-label uk-text-bold">' + label + "</label>";
        html += '<div class="uk-form-controls">';

        if (param.type === "enum" && Array.isArray(param.choices)) {
          html += '<select class="uk-select uk-form-small" name="' + name + '">';
          for (var c = 0; c < param.choices.length; c++) {
            var ch = param.choices[c];
            var val = typeof ch === "object" ? ch.value : ch;
            var lbl = typeof ch === "object" ? ch.label : ch;
            var sel = val === param.default ? " selected" : "";
            html += '<option value="' + window.ViewBlocks.escapeAttr(val) + '"' + sel + ">" + window.ViewBlocks.escapeHtml(lbl) + "</option>";
          }
          html += "</select>";
        } else if (param.type === "integer") {
          var min = typeof param.minimum === "number" ? ' min="' + param.minimum + '"' : "";
          var max = typeof param.maximum === "number" ? ' max="' + param.maximum + '"' : "";
          var defVal = param.default !== undefined ? ' value="' + window.ViewBlocks.escapeAttr(param.default) + '"' : "";
          html += '<input class="uk-input uk-form-small" type="number" name="' + name + '"' + min + max + defVal + " required>";
        } else {
          var strDef = param.default !== undefined ? ' value="' + window.ViewBlocks.escapeAttr(param.default) + '"' : "";
          html += '<input class="uk-input uk-form-small" type="text" name="' + name + '"' + strDef + ">";
        }

        html += "</div></div>";
      }
      html += '<div class="uk-margin-top uk-flex uk-flex-right">';
      html += '<button type="submit" class="uk-button uk-button-primary uk-button-small"><span uk-icon="icon: play"></span> Run</button>';
      html += "</div></form>";
    } else {
      html += '<div class="uk-margin-top uk-flex uk-flex-right">';
      html += '<button type="button" id="run-action-btn" class="uk-button uk-button-primary uk-button-small" data-node-id="' + window.ViewBlocks.escapeAttr(node.id) + '"><span uk-icon="icon: play"></span> Run</button>';
      html += "</div>";
    }

    html += "</div>";
    detailEl.innerHTML = html;

    // Scroll into view if needed
    detailEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function invokeNode(nodeId, params) {
    var mid = nextId("inv");
    var frame = {
      v: 1,
      type: "invoke",
      id: mid,
      node: nodeId,
    };
    if (params && Object.keys(params).length > 0) {
      frame.params = params;
    }
    sendFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Job & Prompt Rendering
  // ---------------------------------------------------------------------------

  function renderJobCard(job) {
    var container = document.getElementById("rich-job-results");
    if (!container) return;

    var elId = "job-card-" + job.job_id;
    var card = document.getElementById(elId);
    if (!card) {
      card = document.createElement("div");
      card.id = elId;
      card.className = "uk-card uk-card-default uk-card-body uk-card-small uk-border-rounded uk-margin-small-bottom job-card";
      container.insertBefore(card, container.firstChild);
    }

    var html = '<div class="uk-flex uk-flex-between uk-flex-middle uk-margin-small-bottom">';
    html += '<div><span class="uk-text-bold">' + window.ViewBlocks.escapeHtml(job.title || job.node || "Job") + '</span> <span class="uk-text-muted uk-text-small">(' + window.ViewBlocks.escapeHtml(job.job_id) + ")</span></div>";

    var stateBadge = "uk-badge";
    if (job.state === "result") stateBadge += " uk-badge-success";
    else if (job.state === "error") stateBadge += " uk-badge-danger";
    else if (job.state === "progress") stateBadge += " uk-badge-warning";
    else if (job.state === "cancelled") stateBadge += " uk-badge-secondary";

    html += '<div class="uk-flex uk-flex-middle" style="gap:8px;"><span class="' + stateBadge + '">' + (job.state || "").toUpperCase() + "</span>";
    if (job.state === "queued" || job.state === "progress") {
      html += '<button type="button" class="uk-button uk-button-danger uk-button-xsmall cancel-job-btn" data-job-id="' + window.ViewBlocks.escapeAttr(job.job_id) + '">Cancel</button>';
    }
    html += "</div></div>";

    if (job.state === "progress") {
      var pct = job.progress && typeof job.progress.pct === "number" ? job.progress.pct : null;
      var msg = (job.progress && job.progress.message) || "Running...";
      html += window.ViewBlocks.renderProgress({ pct: pct, text: msg });
    } else if (job.state === "result") {
      html += '<div class="job-result-blocks">' + window.ViewBlocks.renderBlocks(job.blocks) + "</div>";
      if (job.cursor) {
        html += '<div class="uk-margin-small-top uk-text-center">';
        html += '<button type="button" class="uk-button uk-button-default uk-button-small load-more-btn" data-job-id="' + window.ViewBlocks.escapeAttr(job.job_id) + '" data-cursor="' + window.ViewBlocks.escapeAttr(job.cursor) + '"><span uk-icon="icon: plus"></span> More</button>';
        html += "</div>";
      }
    } else if (job.state === "error") {
      html += '<div class="uk-alert uk-alert-danger uk-margin-small"><p class="uk-margin-remove">' + window.ViewBlocks.escapeHtml(job.error) + "</p></div>";
    } else if (job.state === "cancelled") {
      html += '<div class="uk-alert uk-alert-warning uk-margin-small"><p class="uk-margin-remove">Job was cancelled.</p></div>';
    }

    card.innerHTML = html;
    window.ViewBlocks.mountQrCodes(card);
  }

  function renderPrompt(prompt) {
    var modal = document.getElementById("menu-prompt-modal");
    var body = document.getElementById("menu-prompt-modal-body");
    var title = document.getElementById("menu-prompt-modal-title");
    if (!modal || !body) return;

    if (title) title.textContent = prompt.title || "Confirmation Needed";

    var html = "";
    if (prompt.kind === "confirm") {
      html += '<p class="uk-text-lead">' + window.ViewBlocks.escapeHtml(prompt.message || "Please confirm:") + "</p>";
      html += '<div class="uk-flex uk-flex-right uk-margin-top" style="gap:8px;">';
      html += '<button type="button" class="uk-button uk-button-default prompt-cancel-btn" data-prompt-id="' + window.ViewBlocks.escapeAttr(prompt.prompt_id) + '">' + window.ViewBlocks.escapeHtml(prompt.cancel_label || "Cancel") + "</button>";
      html += '<button type="button" class="uk-button uk-button-primary prompt-confirm-btn" data-prompt-id="' + window.ViewBlocks.escapeAttr(prompt.prompt_id) + '">' + window.ViewBlocks.escapeHtml(prompt.confirm_label || "Confirm") + "</button>";
      html += "</div>";
    } else if (prompt.kind === "select") {
      html += '<p>' + window.ViewBlocks.escapeHtml(prompt.message || "Select an option:") + "</p>";
      html += '<form id="prompt-select-form"><div class="uk-margin-small">';
      var opts = Array.isArray(prompt.options) ? prompt.options : [];
      for (var i = 0; i < opts.length; i++) {
        var opt = opts[i];
        var valStr = JSON.stringify(opt.value);
        var checked = i === 0 ? " checked" : "";
        html += '<label class="uk-display-block uk-margin-small-bottom" style="cursor:pointer;">';
        html += '<input class="uk-radio" type="radio" name="select_opt" value="' + window.ViewBlocks.escapeAttr(valStr) + '"' + checked + "> ";
        html += '<span class="uk-text-bold">' + window.ViewBlocks.escapeHtml(opt.label || "") + "</span>";
        if (opt.detail) {
          html += ' <span class="uk-text-muted uk-text-small">(' + window.ViewBlocks.escapeHtml(opt.detail) + ")</span>";
        }
        html += "</label>";
      }
      html += "</div>";
      html += '<div class="uk-flex uk-flex-right uk-margin-top" style="gap:8px;">';
      html += '<button type="button" class="uk-button uk-button-default prompt-cancel-btn" data-prompt-id="' + window.ViewBlocks.escapeAttr(prompt.prompt_id) + '">Cancel</button>';
      html += '<button type="submit" class="uk-button uk-button-primary">Submit</button>';
      html += "</div></form>";
    } else if (prompt.kind === "form") {
      html += '<form id="prompt-form-widget" class="uk-form-stacked">';
      var fields = Array.isArray(prompt.fields) ? prompt.fields : [];
      for (var f = 0; f < fields.length; f++) {
        var fld = fields[f];
        html += '<div class="uk-margin-small">';
        html += '<label class="uk-form-label uk-text-bold">' + window.ViewBlocks.escapeHtml(fld.label || fld.name) + "</label>";
        html += '<div class="uk-form-controls">';
        if (fld.type === "enum" && Array.isArray(fld.choices)) {
          html += '<select class="uk-select" name="' + window.ViewBlocks.escapeAttr(fld.name) + '">';
          for (var fc = 0; fc < fld.choices.length; fc++) {
            var cItem = fld.choices[fc];
            var cVal = typeof cItem === "object" ? cItem.value : cItem;
            var cLbl = typeof cItem === "object" ? cItem.label : cItem;
            html += '<option value="' + window.ViewBlocks.escapeAttr(cVal) + '">' + window.ViewBlocks.escapeHtml(cLbl) + "</option>";
          }
          html += "</select>";
        } else {
          html += '<input class="uk-input" type="text" name="' + window.ViewBlocks.escapeAttr(fld.name) + '" value="' + window.ViewBlocks.escapeAttr(fld.default || "") + '">';
        }
        html += "</div></div>";
      }
      html += '<div class="uk-flex uk-flex-right uk-margin-top" style="gap:8px;">';
      html += '<button type="button" class="uk-button uk-button-default prompt-cancel-btn" data-prompt-id="' + window.ViewBlocks.escapeAttr(prompt.prompt_id) + '">Cancel</button>';
      html += '<button type="submit" class="uk-button uk-button-primary">Submit</button>';
      html += "</div></form>";
    }

    body.innerHTML = html;
    if (window.UIkit && window.UIkit.modal) {
      window.UIkit.modal(modal).show();
    }
  }

  function hidePromptModal() {
    var modal = document.getElementById("menu-prompt-modal");
    if (modal && window.UIkit && window.UIkit.modal) {
      window.UIkit.modal(modal).hide();
    }
    activePrompt = null;
  }

  function answerPrompt(promptId, answerData) {
    var frame = {
      v: 1,
      type: "answer",
      id: nextId("ans"),
      prompt_id: promptId,
    };
    for (var k in answerData) {
      if (answerData.hasOwnProperty(k)) {
        frame[k] = answerData[k];
      }
    }
    sendFrame(frame);
    hidePromptModal();
  }

  // ---------------------------------------------------------------------------
  // Mirror Mode (Thin Mode Attach to Default Session)
  // ---------------------------------------------------------------------------

  function renderMirrorView(frame) {
    var screenEl = document.getElementById("mirror-screen-blocks");
    var titleEl = document.getElementById("mirror-title");
    var breadcrumbEl = document.getElementById("mirror-breadcrumb");
    var drivenEl = document.getElementById("mirror-driven-by");
    var hintsEl = document.getElementById("mirror-hints");

    if (titleEl) titleEl.textContent = frame.title || frame.screen || "WLAN Pi";
    if (breadcrumbEl) {
      var bc = Array.isArray(frame.breadcrumb) ? frame.breadcrumb.join(" > ") : "";
      breadcrumbEl.textContent = bc;
    }
    if (drivenEl) {
      if (frame.driven_by && frame.driven_by.principal) {
        var drv = frame.driven_by;
        var drvName = drv.principal.name || drv.principal.kind;
        var surf = drv.surface ? " (" + drv.surface + ")" : "";
        var selfTag = drv.self ? " [you]" : "";
        drivenEl.textContent = "Driven by: " + drvName + surf + selfTag;
        drivenEl.style.display = "block";
      } else {
        drivenEl.style.display = "none";
      }
    }

    if (screenEl) {
      var blocks = Array.isArray(frame.blocks) ? frame.blocks : [];
      screenEl.innerHTML = window.ViewBlocks.renderBlocks(blocks);
      window.ViewBlocks.mountQrCodes(screenEl);
    }

    if (hintsEl && frame.hints) {
      var hintParts = [];
      for (var k in frame.hints) {
        if (frame.hints.hasOwnProperty(k)) {
          hintParts.push("<strong>" + window.ViewBlocks.escapeHtml(k.toUpperCase()) + ":</strong> " + window.ViewBlocks.escapeHtml(frame.hints[k]));
        }
      }
      hintsEl.innerHTML = hintParts.join(" &nbsp;|&nbsp; ");
    }
  }

  function sendInput(key) {
    if (!key) return;
    var frame = {
      v: 1,
      type: "input",
      id: nextId("inp"),
      key: key,
      action: "press",
    };
    sendFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Toast notifications & Helpers
  // ---------------------------------------------------------------------------

  function showToast(message, status) {
    if (window.UIkit && window.UIkit.notification) {
      window.UIkit.notification({
        message: window.ViewBlocks.escapeHtml(message),
        status: status || "primary",
        pos: "top-right",
        timeout: 4000,
      });
    } else {
      console.log("[toast]", status, message);
    }
  }

  window.wlanpiToggleSecret = function (btn) {
    var cell = btn.closest(".kv-secret-cell");
    if (!cell) return;
    var mask = cell.querySelector(".kv-secret-mask");
    var plain = cell.querySelector(".kv-secret-plain");
    if (!mask || !plain) return;

    if (plain.style.display === "none") {
      plain.style.display = "inline";
      mask.style.display = "none";
      btn.textContent = "Hide";
    } else {
      plain.style.display = "none";
      mask.style.display = "inline";
      btn.textContent = "Show";
    }
  };

  // ---------------------------------------------------------------------------
  // DOM Event Bindings
  // ---------------------------------------------------------------------------

  function bindEvents() {
    var panel = document.getElementById("menu-panel");
    if (!panel) return;

    // Toggle mirror mode switch
    var mirrorToggle = document.getElementById("toggle-mirror-mode");
    if (mirrorToggle) {
      mirrorToggle.onchange = function () {
        var isMirror = mirrorToggle.checked;
        disconnect();
        if (isMirror) {
          currentMode = "thin";
          currentSession = "default";
          document.getElementById("rich-mode-container").style.display = "none";
          document.getElementById("mirror-mode-container").style.display = "block";
        } else {
          currentMode = "rich";
          currentSession = "new";
          document.getElementById("rich-mode-container").style.display = "block";
          document.getElementById("mirror-mode-container").style.display = "none";
        }
        connect();
      };
    }

    // D-Pad buttons
    panel.addEventListener("click", function (evt) {
      // Retry connection button
      var retryBtn = evt.target.closest(".menu-retry-btn");
      if (retryBtn) {
        evt.preventDefault();
        retryConnect();
        return;
      }

      var dpadBtn = evt.target.closest("[data-dpad-key]");
      if (dpadBtn) {
        var key = dpadBtn.getAttribute("data-dpad-key");
        sendInput(key);
        return;
      }

      // Breadcrumb click
      var bcLink = evt.target.closest(".bc-link");
      if (bcLink) {
        evt.preventDefault();
        var branchId = bcLink.getAttribute("data-id") || null;
        currentBranchId = branchId;
        renderRichMenuTree();
        return;
      }

      // Menu node card click
      var nodeCard = evt.target.closest(".menu-node-card");
      if (nodeCard) {
        var nodeId = nodeCard.getAttribute("data-node-id");
        var isBranch = nodeCard.getAttribute("data-is-branch") === "1";
        handleNodeClick(nodeId, isBranch);
        return;
      }

      // Close action detail
      if (evt.target.closest("#close-action-detail")) {
        var detailEl = document.getElementById("rich-action-detail");
        if (detailEl) detailEl.style.display = "none";
        return;
      }

      // Run action button (no params)
      var runBtn = evt.target.closest("#run-action-btn");
      if (runBtn) {
        var actNodeId = runBtn.getAttribute("data-node-id");
        invokeNode(actNodeId, {});
        return;
      }

      // Cancel job button
      var cancelJobBtn = evt.target.closest(".cancel-job-btn");
      if (cancelJobBtn) {
        var cJobId = cancelJobBtn.getAttribute("data-job-id");
        sendFrame({ v: 1, type: "cancel", id: nextId("can"), job_id: cJobId });
        return;
      }

      // Load more results button
      var loadMoreBtn = evt.target.closest(".load-more-btn");
      if (loadMoreBtn) {
        var pJobId = loadMoreBtn.getAttribute("data-job-id");
        var pCursor = loadMoreBtn.getAttribute("data-cursor");
        sendFrame({ v: 1, type: "page", id: nextId("page"), job_id: pJobId, cursor: pCursor });
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<span uk-spinner="ratio: 0.6"></span> Loading...';
        return;
      }

      // Prompt modal confirm / cancel buttons
      var promptConfirmBtn = evt.target.closest(".prompt-confirm-btn");
      if (promptConfirmBtn) {
        var pId = promptConfirmBtn.getAttribute("data-prompt-id");
        answerPrompt(pId, { confirmed: true });
        return;
      }
      var promptCancelBtn = evt.target.closest(".prompt-cancel-btn");
      if (promptCancelBtn) {
        var pId2 = promptCancelBtn.getAttribute("data-prompt-id");
        answerPrompt(pId2, { cancel: true });
        return;
      }

      // Embedded view block confirm buttons
      var confirmOkBtn = evt.target.closest(".confirm-ok-btn");
      if (confirmOkBtn) {
        var promptId = confirmOkBtn.getAttribute("data-prompt-id");
        answerPrompt(promptId, { confirmed: true });
        return;
      }
      var confirmCancelBtn = evt.target.closest(".confirm-cancel-btn");
      if (confirmCancelBtn) {
        var promptId2 = confirmCancelBtn.getAttribute("data-prompt-id");
        answerPrompt(promptId2, { cancel: true });
        return;
      }
    });

    // Form submit for parameterized action
    panel.addEventListener("submit", function (evt) {
      if (evt.target.id === "action-params-form") {
        evt.preventDefault();
        var form = evt.target;
        var fd = new FormData(form);
        var paramsObj = {};
        fd.forEach(function (value, key) {
          // If numeric string and required, convert
          if (/^-?\d+$/.test(value)) {
            paramsObj[key] = parseInt(value, 10);
          } else {
            paramsObj[key] = value;
          }
        });
        var detailNodeCard = document.querySelector("#rich-action-detail [data-node-id]");
        var nId = detailNodeCard ? detailNodeCard.getAttribute("data-node-id") : null;
        if (!nId) {
          var runBtn = document.getElementById("run-action-btn");
          nId = runBtn ? runBtn.getAttribute("data-node-id") : null;
        }
        if (nId) {
          invokeNode(nId, paramsObj);
        }
        return;
      }

      // Prompt select form submit
      if (evt.target.id === "prompt-select-form") {
        evt.preventDefault();
        var selRadio = evt.target.querySelector('input[name="select_opt"]:checked');
        if (selRadio && activePrompt) {
          try {
            var parsedVal = JSON.parse(selRadio.value);
            answerPrompt(activePrompt.prompt_id, { value: parsedVal });
          } catch (e) {
            answerPrompt(activePrompt.prompt_id, { value: selRadio.value });
          }
        }
        return;
      }

      // Prompt form widget submit
      if (evt.target.id === "prompt-form-widget") {
        evt.preventDefault();
        if (!activePrompt) return;
        var pForm = evt.target;
        var pFd = new FormData(pForm);
        var vals = {};
        pFd.forEach(function (value, key) {
          vals[key] = value;
        });
        answerPrompt(activePrompt.prompt_id, { values: vals });
        return;
      }
    });

    // Keyboard arrow keys mapped to thin mode input
    window.addEventListener("keydown", function (evt) {
      if (currentMode !== "thin") return;
      // Ignore if user is typing in an input/textarea
      var activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.tagName === "SELECT")) {
        return;
      }

      var keyMap = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        Enter: "center",
      };
      var mapped = keyMap[evt.key];
      if (mapped) {
        evt.preventDefault();
        sendInput(mapped);
      }
    });
  }

  function init() {
    var panel = document.getElementById("menu-panel");
    if (!panel || panel.dataset.initialized === "1") return;
    panel.dataset.initialized = "1";

    bindEvents();
    connect();
  }

  // HTMX and page load lifecycle
  document.addEventListener("htmx:after:swap", function (evt) {
    if (document.getElementById("menu-panel")) {
      init();
    } else {
      disconnect();
    }
  });

  window.addEventListener("DOMContentLoaded", init);
  window.addEventListener("load", init);
})();

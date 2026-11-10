/**
 * View block renderers for wlanpi-menud protocol v1 view blocks.
 *
 * Supported block types:
 *   - text (style: body, heading, mono, muted)
 *   - kv (key-value items, secret masking with a delegated reveal toggle)
 *   - table (columns with alignment and priority, rows, per-row details expander)
 *   - list (items with label, detail, selected index; items with a node are links)
 *   - qr (QR code rendering via QRCode library/canvas with text fallback)
 *   - status (levels: ok, info, warn, error)
 *   - progress (indeterminate or percentage, label)
 *   - confirm (message, confirm/cancel buttons, or screen text for key-driven surfaces)
 *   - fallback (renders plain text for any unsupported/corrupt block)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else if (typeof define === "function" && define.amd) {
    define([], factory);
  } else {
    root.ViewBlocks = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function renderFallback(block) {
    var text = (block && typeof block.text === "string") ? block.text : "";
    if (!text && block) {
      try {
        text = JSON.stringify(block, null, 2);
      } catch (e) {
        text = String(block);
      }
    }
    return (
      '<div class="view-block block-fallback block-text uk-margin-small-bottom">' +
      '<pre class="uk-text-small view-pre"><code>' +
      escapeHtml(text) +
      "</code></pre></div>"
    );
  }

  function renderText(block) {
    if (!block || typeof block.text !== "string") return renderFallback(block);
    var style = block.style || "body";
    var text = escapeHtml(block.text);

    switch (style) {
      case "heading":
        return (
          '<div class="view-block block-text block-heading uk-margin-small-bottom">' +
          '<h4 class="uk-text-bold uk-margin-remove view-heading"><span>' +
          text +
          "</span></h4></div>"
        );
      case "mono":
        return (
          '<div class="view-block block-text block-mono uk-margin-small-bottom">' +
          '<pre class="uk-text-small uk-margin-remove view-pre"><code>' +
          text +
          "</code></pre></div>"
        );
      case "muted":
        return (
          '<div class="view-block block-text block-muted uk-margin-small-bottom">' +
          '<p class="uk-text-muted uk-text-small uk-margin-remove">' +
          text +
          "</p></div>"
        );
      case "body":
      default:
        return (
          '<div class="view-block block-text block-body uk-margin-small-bottom">' +
          '<p class="uk-text-default uk-margin-remove">' +
          text +
          "</p></div>"
        );
    }
  }

  function renderKv(block) {
    if (!block || !Array.isArray(block.items)) return renderFallback(block);

    var html = '<div class="view-block block-kv uk-margin-small-bottom">';
    html += '<table class="uk-table uk-table-small uk-table-divider uk-margin-remove view-table">';
    html += "<tbody>";

    for (var i = 0; i < block.items.length; i++) {
      var item = block.items[i];
      if (!item || typeof item !== "object") continue;
      var key = escapeHtml(item.key || "");
      var rawVal = item.value;
      var isSecret = Boolean(item.secret);

      html += "<tr>";
      html += '<td class="uk-text-bold uk-width-small uk-text-break view-kv-key">' + key + "</td>";

      if (isSecret) {
        var strVal = rawVal === null || rawVal === undefined ? "" : String(rawVal);
        html += '<td class="uk-text-break kv-secret-cell">';
        html += '<span class="kv-secret-mask">••••••••</span>';
        html += '<span class="kv-secret-plain" hidden>' + escapeHtml(strVal) + "</span>";
        html += ' <button type="button" class="uk-button uk-button-link uk-text-small uk-margin-small-left toggle-secret-btn" aria-pressed="false">Show</button>';
        html += "</td>";
      } else {
        var displayVal = rawVal === null || rawVal === undefined ? "—" : String(rawVal);
        html += '<td class="uk-text-break">' + escapeHtml(displayVal) + "</td>";
      }

      html += "</tr>";
    }

    html += "</tbody></table></div>";
    return html;
  }

  // Columns carry their index and the schema's `priority` hint as data
  // attributes; the page drops the highest numbers first on a narrow surface
  // and reveals the per-row details expander for what it dropped.
  function renderTable(block) {
    if (!block || !Array.isArray(block.columns) || !Array.isArray(block.rows)) {
      return renderFallback(block);
    }

    var html = '<div class="view-block block-table uk-overflow-auto uk-margin-small-bottom">';
    html += '<table class="uk-table uk-table-small uk-table-divider uk-margin-remove view-table">';
    html += "<thead><tr>";

    for (var c = 0; c < block.columns.length; c++) {
      var col = block.columns[c] || {};
      var attrs = ' scope="col" data-col="' + c + '"';
      if (typeof col.priority === "number") attrs += ' data-priority="' + col.priority + '"';
      if (col.align === "right") attrs += ' class="uk-text-right"';
      html += "<th" + attrs + ">" + escapeHtml(col.label || col.key || "") + "</th>";
    }
    html += '<th class="table-expander-cell" hidden><span class="visually-hidden">Details</span></th>';

    html += "</tr></thead><tbody>";

    for (var r = 0; r < block.rows.length; r++) {
      var row = block.rows[r];
      html += "<tr>";
      for (var ci = 0; ci < block.columns.length; ci++) {
        var cellVal = Array.isArray(row) ? row[ci] : undefined;
        var cellAttrs = ' data-col="' + ci + '"';
        if ((block.columns[ci] || {}).align === "right") cellAttrs += ' class="uk-text-right"';
        var disp = cellVal === null || cellVal === undefined ? "—" : String(cellVal);
        html += "<td" + cellAttrs + ">" + escapeHtml(disp) + "</td>";
      }
      html += '<td class="table-expander-cell" hidden>' +
        '<button type="button" class="uk-button uk-button-link uk-text-small table-expander-btn" aria-expanded="false">Details</button></td>';
      html += "</tr>";
    }

    html += "</tbody></table></div>";
    return html;
  }

  function renderList(block, opts) {
    if (!block || !Array.isArray(block.items)) return renderFallback(block);

    var links = !opts || opts.links !== false;
    var selectedIdx = typeof block.selected === "number" ? block.selected : -1;
    var html = '<div class="view-block block-list uk-margin-small-bottom">';
    html += '<ul class="uk-list uk-list-divider uk-margin-remove view-list">';

    for (var i = 0; i < block.items.length; i++) {
      var item = block.items[i];
      if (!item || typeof item !== "object") continue;
      var isSelected = i === selectedIdx;
      var itemClass = isSelected ? "list-item list-item-selected" : "list-item";

      html += '<li class="' + itemClass + '" data-index="' + i + '"';
      if (item.node) html += ' data-node="' + escapeAttr(item.node) + '"';
      if (isSelected) html += ' aria-current="true"';
      html += ">";

      var inner = '<span class="list-item-left">';
      if (isSelected) inner += '<span class="list-item-cursor" aria-hidden="true">›</span>';
      inner += "<span>" + escapeHtml(item.label || "") + "</span></span>";
      inner += '<span class="list-item-right">';
      if (item.detail) {
        inner += '<span class="list-item-detail uk-text-small">' + escapeHtml(item.detail) + "</span>";
      }
      if (item.branch) {
        inner += '<span class="list-item-chevron" uk-icon="icon: chevron-right" aria-hidden="true"></span>';
      }
      inner += "</span>";

      if (item.node && links) {
        // The hash is the node id exactly as sent.
        html += '<a class="list-item-row" href="#' + escapeAttr(encodeURIComponent(item.node).replace(/%2E/gi, ".")) + '">' + inner + "</a>";
      } else {
        html += '<span class="list-item-row">' + inner + "</span>";
      }

      html += "</li>";
    }

    html += "</ul></div>";
    return html;
  }

  function renderQr(block) {
    if (!block || typeof block.data !== "string") return renderFallback(block);

    var data = block.data;
    var caption = block.caption ? escapeHtml(block.caption) : "";
    var fallbackText = block.text ? escapeHtml(block.text) : escapeHtml(data);

    var html = '<div class="view-block block-qr uk-text-center uk-margin-small-bottom">';
    html += '<div class="qr-canvas-slot uk-flex uk-flex-center uk-margin-small-bottom" data-qr-payload="' + escapeAttr(data) + '">';
    // Placeholder container for dynamic rendering by QRCode or canvas
    html += '<div class="qr-code-target"></div>';
    html += "</div>";

    if (caption) {
      html += '<div class="uk-text-bold uk-text-small uk-margin-small-bottom">' + caption + "</div>";
    }

    // Text fallback collapsible
    html += '<details class="uk-margin-small-top uk-text-left">';
    html += '<summary class="uk-text-small view-summary">QR content as text</summary>';
    html += '<pre class="uk-text-small uk-margin-small-top view-pre"><code>' + fallbackText + "</code></pre>";
    html += "</details>";

    html += "</div>";
    return html;
  }

  // Status is never colour alone: each level carries an icon and a word.
  var LEVELS = {
    ok: { cls: "success", icon: "check", word: "OK" },
    info: { cls: "primary", icon: "info", word: "Info" },
    warn: { cls: "warning", icon: "warning", word: "Warning" },
    error: { cls: "danger", icon: "close", word: "Error" },
  };

  function renderStatus(block) {
    if (!block || typeof block.level !== "string") return renderFallback(block);

    var level = block.level.toLowerCase();
    var meta = LEVELS[level] || LEVELS.info;
    var label = block.label ? escapeHtml(block.label) : meta.word;
    var text = escapeHtml(block.text || "");

    return (
      '<div class="view-block block-status uk-alert uk-alert-' + meta.cls + ' uk-margin-small-bottom" data-level="' + escapeAttr(level) + '">' +
      '<div class="view-status-row">' +
      '<span uk-icon="icon: ' + meta.icon + '" aria-hidden="true"></span>' +
      "<div>" +
      '<strong class="view-status-label">' + label + ":</strong> " +
      text +
      "</div>" +
      "</div></div>"
    );
  }

  function renderProgress(block) {
    if (!block) return renderFallback(block);

    var pct = typeof block.pct === "number" ? Math.max(0, Math.min(100, block.pct)) : null;
    var label = block.label ? escapeHtml(block.label) : "";
    var text = block.text ? escapeHtml(block.text) : (pct !== null ? pct + "%" : "Working…");

    var html = '<div class="view-block block-progress uk-margin-small-bottom">';
    html += '<div class="uk-flex uk-flex-between uk-text-small uk-margin-xsmall-bottom">';
    if (label) html += '<span class="uk-text-bold">' + label + "</span>";
    html += '<span class="uk-text-muted">' + text + "</span>";
    html += "</div>";

    if (pct === null) {
      html += '<progress class="uk-progress uk-margin-remove" aria-label="' + (label || "Progress") + '"></progress>';
    } else {
      html += '<progress class="uk-progress uk-margin-remove" value="' + pct + '" max="100" aria-label="' + (label || "Progress") + '">' + pct + "%</progress>";
    }

    html += "</div>";
    return html;
  }

  // Interactive (default): two buttons carrying the prompt id.
  // opts.interactive === false: the same content as plain screen text with the
  // cursor shown, for a surface that answers with keys (the Front panel pane).
  function renderConfirm(block, opts) {
    if (!block || !block.prompt_id || typeof block.message !== "string") {
      return renderFallback(block);
    }

    var promptId = escapeAttr(block.prompt_id);
    var message = escapeHtml(block.message);
    var confirmLabel = escapeHtml(block.confirm_label || "Confirm");
    var cancelLabel = escapeHtml(block.cancel_label || "Cancel");
    var selected = block.selected === "confirm" ? "confirm" : "cancel";

    if (opts && opts.interactive === false) {
      var cancelCls = "confirm-choice" + (selected === "cancel" ? " confirm-choice-selected" : "");
      var okCls = "confirm-choice" + (selected === "confirm" ? " confirm-choice-selected" : "");
      return (
        '<div class="view-block block-confirm block-confirm-static uk-margin-small-bottom" data-prompt-id="' + promptId + '">' +
        '<p class="uk-text-bold uk-margin-small-bottom">' + message + "</p>" +
        '<div class="confirm-choices">' +
        '<span class="' + cancelCls + '"' + (selected === "cancel" ? ' aria-current="true"' : "") + ">" + cancelLabel + "</span>" +
        '<span class="' + okCls + '"' + (selected === "confirm" ? ' aria-current="true"' : "") + ">" + confirmLabel + "</span>" +
        "</div></div>"
      );
    }

    var cancelBtnClass = selected === "cancel" ? "uk-button-primary" : "uk-button-default";
    var confirmBtnClass = selected === "confirm" ? "uk-button-primary" : "uk-button-danger";

    var html = '<div class="view-block block-confirm uk-margin-small-bottom" data-prompt-id="' + promptId + '">';
    html += '<p class="uk-text-bold uk-margin-small-bottom">' + message + "</p>";
    html += '<div class="uk-flex uk-flex-right confirm-buttons">';
    html += '<button type="button" class="uk-button ' + cancelBtnClass + ' uk-button-small confirm-cancel-btn" data-confirm="cancel" data-prompt-id="' + promptId + '">' + cancelLabel + "</button>";
    html += '<button type="button" class="uk-button ' + confirmBtnClass + ' uk-button-small confirm-ok-btn" data-confirm="confirm" data-prompt-id="' + promptId + '">' + confirmLabel + "</button>";
    html += "</div></div>";
    return html;
  }

  function renderBlock(block, opts) {
    if (!block || typeof block !== "object" || typeof block.type !== "string") {
      return renderFallback(block);
    }

    switch (block.type) {
      case "text":
        return renderText(block);
      case "kv":
        return renderKv(block);
      case "table":
        return renderTable(block);
      case "list":
        return renderList(block, opts);
      case "qr":
        return renderQr(block);
      case "status":
        return renderStatus(block);
      case "progress":
        return renderProgress(block);
      case "confirm":
        return renderConfirm(block, opts);
      default:
        return renderFallback(block);
    }
  }

  /**
   * @param {Array} blocks
   * @param {object} [opts]  { interactive: false } renders confirm blocks as
   *   screen text; { links: false } renders list items without links.
   */
  function renderBlocks(blocks, opts) {
    if (!Array.isArray(blocks)) return "";
    var out = "";
    for (var i = 0; i < blocks.length; i++) {
      out += renderBlock(blocks[i], opts);
    }
    return out;
  }

  // ---- Delegated behaviour ----------------------------------------------

  function closest(el, selector) {
    return el && typeof el.closest === "function" ? el.closest(selector) : null;
  }

  function toggleSecret(btn) {
    var cell = closest(btn, ".kv-secret-cell");
    if (!cell) return;
    var mask = cell.querySelector(".kv-secret-mask");
    var plain = cell.querySelector(".kv-secret-plain");
    var reveal = btn.getAttribute("aria-pressed") !== "true";
    if (mask) mask.hidden = reveal;
    if (plain) plain.hidden = !reveal;
    btn.setAttribute("aria-pressed", reveal ? "true" : "false");
    btn.textContent = reveal ? "Hide" : "Show";
  }

  // The details row lists the columns the page dropped for width.
  function toggleRowDetails(btn) {
    var row = closest(btn, "tr");
    var table = closest(btn, "table");
    if (!row || !table) return;
    var next = row.nextElementSibling;
    if (next && next.classList.contains("table-detail-row")) {
      next.parentNode.removeChild(next);
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    var doc = btn.ownerDocument;
    var detail = doc.createElement("tr");
    detail.className = "table-detail-row";
    var td = doc.createElement("td");
    td.colSpan = row.children.length;
    var dl = doc.createElement("dl");
    dl.className = "table-detail-list";
    var cells = row.children;
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!cell.hidden || !cell.hasAttribute("data-col")) continue;
      var head = table.querySelector('thead th[data-col="' + cell.getAttribute("data-col") + '"]');
      var dt = doc.createElement("dt");
      dt.textContent = head ? head.textContent : "";
      var dd = doc.createElement("dd");
      dd.textContent = cell.textContent;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    td.appendChild(dl);
    detail.appendChild(td);
    row.parentNode.insertBefore(detail, row.nextSibling);
    btn.setAttribute("aria-expanded", "true");
  }

  /**
   * Handle a click that landed inside rendered blocks. Call from one delegated
   * listener on the container. Returns true when the click was a block control.
   */
  function handleClick(evt) {
    var target = evt && evt.target;
    var secret = closest(target, ".toggle-secret-btn");
    if (secret) {
      toggleSecret(secret);
      return true;
    }
    var expander = closest(target, ".table-expander-btn");
    if (expander) {
      toggleRowDetails(expander);
      return true;
    }
    return false;
  }

  // Draw QR code into any .qr-canvas-slot inside container
  function mountQrCodes(container) {
    if (!container) return;
    var slots = container.querySelectorAll(".qr-canvas-slot");
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slot.dataset.mounted === "1") continue;
      var payload = slot.getAttribute("data-qr-payload");
      var target = slot.querySelector(".qr-code-target");
      if (!payload || !target) continue;

      slot.dataset.mounted = "1";
      if (typeof root.QRCode === "function") {
        try {
          target.innerHTML = "";
          new root.QRCode(target, {
            text: payload,
            width: 160,
            height: 160,
            correctLevel: root.QRCode.CorrectLevel.M,
          });
        } catch (e) {
          // Keep text fallback visible
        }
      }
    }
  }

  return {
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    renderBlock: renderBlock,
    renderBlocks: renderBlocks,
    renderText: renderText,
    renderKv: renderKv,
    renderTable: renderTable,
    renderList: renderList,
    renderQr: renderQr,
    renderStatus: renderStatus,
    renderProgress: renderProgress,
    renderConfirm: renderConfirm,
    renderFallback: renderFallback,
    mountQrCodes: mountQrCodes,
    handleClick: handleClick,
    toggleSecret: toggleSecret,
    toggleRowDetails: toggleRowDetails,
  };
});

/**
 * View block renderers for wlanpi-menud protocol v1 view blocks.
 *
 * Supported block types:
 *   - text (style: body, heading, mono, muted)
 *   - kv (key-value items, secret masking with reveal toggle)
 *   - table (columns with alignment, rows)
 *   - list (items with label, detail, selected index)
 *   - qr (QR code rendering via QRCode library/canvas with text fallback)
 *   - status (levels: ok, info, warn, error)
 *   - progress (indeterminate or percentage, label)
 *   - confirm (message, confirm/cancel buttons)
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
      '<pre class="uk-text-small uk-background-muted uk-padding-small uk-border-rounded"><code>' +
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
          '<h4 class="uk-heading-line uk-text-bold uk-margin-remove"><span>' +
          text +
          "</span></h4></div>"
        );
      case "mono":
        return (
          '<div class="view-block block-text block-mono uk-margin-small-bottom">' +
          '<pre class="uk-text-small uk-background-muted uk-padding-small uk-border-rounded uk-margin-remove"><code>' +
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
    html += '<table class="uk-table uk-table-small uk-table-divider uk-table-hover uk-margin-remove">';
    html += "<tbody>";

    for (var i = 0; i < block.items.length; i++) {
      var item = block.items[i];
      if (!item || typeof item !== "object") continue;
      var key = escapeHtml(item.key || "");
      var rawVal = item.value;
      var isSecret = Boolean(item.secret);

      html += "<tr>";
      html += '<td class="uk-text-bold uk-width-small uk-text-break">' + key + "</td>";

      if (isSecret) {
        var strVal = rawVal === null || rawVal === undefined ? "" : String(rawVal);
        html += '<td class="uk-text-break kv-secret-cell">';
        html += '<span class="kv-secret-mask">••••••••</span>';
        html += '<span class="kv-secret-plain" style="display:none;">' + escapeHtml(strVal) + "</span>";
        html += ' <button type="button" class="uk-button uk-button-link uk-text-small uk-margin-small-left toggle-secret-btn" onclick="wlanpiToggleSecret(this)">Show</button>';
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

  function renderTable(block) {
    if (!block || !Array.isArray(block.columns) || !Array.isArray(block.rows)) {
      return renderFallback(block);
    }

    var html = '<div class="view-block block-table uk-overflow-auto uk-margin-small-bottom">';
    html += '<table class="uk-table uk-table-small uk-table-divider uk-table-hover uk-margin-remove">';
    html += "<thead><tr>";

    for (var c = 0; c < block.columns.length; c++) {
      var col = block.columns[c];
      var alignClass = col.align === "right" ? ' class="uk-text-right"' : "";
      html += "<th" + alignClass + ">" + escapeHtml(col.label || col.key || "") + "</th>";
    }

    html += "</tr></thead><tbody>";

    for (var r = 0; r < block.rows.length; r++) {
      var row = block.rows[r];
      html += "<tr>";
      for (var ci = 0; ci < block.columns.length; ci++) {
        var cellVal = Array.isArray(row) ? row[ci] : undefined;
        var cellAlignClass = block.columns[ci].align === "right" ? ' class="uk-text-right"' : "";
        var disp = cellVal === null || cellVal === undefined ? "—" : String(cellVal);
        html += "<td" + cellAlignClass + ">" + escapeHtml(disp) + "</td>";
      }
      html += "</tr>";
    }

    html += "</tbody></table></div>";
    return html;
  }

  function renderList(block) {
    if (!block || !Array.isArray(block.items)) return renderFallback(block);

    var selectedIdx = typeof block.selected === "number" ? block.selected : -1;
    var html = '<div class="view-block block-list uk-margin-small-bottom">';
    html += '<ul class="uk-list uk-list-divider uk-margin-remove">';

    for (var i = 0; i < block.items.length; i++) {
      var item = block.items[i];
      if (!item || typeof item !== "object") continue;
      var isSelected = i === selectedIdx;
      var itemClass = isSelected
        ? "list-item uk-text-primary uk-text-bold uk-background-muted uk-padding-small uk-border-rounded"
        : "list-item uk-padding-small uk-border-rounded";

      html += '<li class="' + itemClass + '" data-index="' + i + '"';
      if (item.node) html += ' data-node="' + escapeAttr(item.node) + '"';
      html += ' style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;">';

      html += '<div class="list-item-left" style="display:flex; align-items:center; gap:8px;">';
      if (isSelected) {
        html += '<span class="uk-badge" style="background:#1e87f0;">›</span>';
      }
      html += '<span>' + escapeHtml(item.label || "") + "</span>";
      html += "</div>";

      html += '<div class="list-item-right" style="display:flex; align-items:center; gap:8px;">';
      if (item.detail) {
        html += '<span class="uk-text-muted uk-text-small">' + escapeHtml(item.detail) + "</span>";
      }
      if (item.branch) {
        html += '<span class="uk-text-muted" uk-icon="icon: chevron-right"></span>';
      }
      html += "</div>";

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

    var html = '<div class="view-block block-qr uk-text-center uk-margin-small-bottom uk-card uk-card-default uk-card-body uk-card-small uk-border-rounded">';
    html += '<div class="qr-canvas-slot uk-flex uk-flex-center uk-margin-small-bottom" data-qr-payload="' + escapeAttr(data) + '">';
    // Placeholder container for dynamic rendering by QRCode or canvas
    html += '<div class="qr-code-target"></div>';
    html += "</div>";

    if (caption) {
      html += '<div class="uk-text-bold uk-text-small uk-margin-small-bottom">' + caption + "</div>";
    }

    // Text fallback collapsible
    html += '<details class="uk-margin-small-top uk-text-left">';
    html += '<summary class="uk-text-muted uk-text-small" style="cursor:pointer;">QR Content (Text Fallback)</summary>';
    html += '<pre class="uk-text-small uk-background-muted uk-padding-small uk-border-rounded uk-margin-small-top"><code>' + fallbackText + "</code></pre>";
    html += "</details>";

    html += "</div>";
    return html;
  }

  function renderStatus(block) {
    if (!block || typeof block.level !== "string") return renderFallback(block);

    var level = block.level.toLowerCase();
    var alertClass = "primary";
    var icon = "info";

    switch (level) {
      case "ok":
        alertClass = "success";
        icon = "check";
        break;
      case "info":
        alertClass = "primary";
        icon = "info";
        break;
      case "warn":
        alertClass = "warning";
        icon = "warning";
        break;
      case "error":
        alertClass = "danger";
        icon = "close";
        break;
      default:
        alertClass = "muted";
        icon = "info";
    }

    var label = block.label ? escapeHtml(block.label) : level.toUpperCase();
    var text = escapeHtml(block.text || "");

    return (
      '<div class="view-block block-status uk-alert uk-alert-' +
      alertClass +
      ' uk-margin-small-bottom" uk-alert>' +
      '<div style="display:flex; align-items:center; gap:8px;">' +
      '<span uk-icon="icon: ' +
      icon +
      '"></span>' +
      "<div>" +
      '<strong class="uk-text-uppercase">' +
      label +
      ":</strong> " +
      text +
      "</div>" +
      "</div></div>"
    );
  }

  function renderProgress(block) {
    if (!block) return renderFallback(block);

    var pct = typeof block.pct === "number" ? Math.max(0, Math.min(100, block.pct)) : null;
    var label = block.label ? escapeHtml(block.label) : "";
    var text = block.text ? escapeHtml(block.text) : (pct !== null ? pct + "%" : "Processing...");

    var html = '<div class="view-block block-progress uk-margin-small-bottom">';
    html += '<div class="uk-flex uk-flex-between uk-text-small uk-margin-xsmall-bottom">';
    if (label) html += '<span class="uk-text-bold">' + label + "</span>";
    html += '<span class="uk-text-muted">' + text + "</span>";
    html += "</div>";

    if (pct === null) {
      html += '<progress class="uk-progress uk-margin-remove"></progress>';
    } else {
      html += '<progress class="uk-progress uk-margin-remove" value="' + pct + '" max="100">' + pct + "%</progress>";
    }

    html += "</div>";
    return html;
  }

  function renderConfirm(block) {
    if (!block || !block.prompt_id || typeof block.message !== "string") {
      return renderFallback(block);
    }

    var promptId = escapeAttr(block.prompt_id);
    var message = escapeHtml(block.message);
    var confirmLabel = escapeHtml(block.confirm_label || "Confirm");
    var cancelLabel = escapeHtml(block.cancel_label || "Cancel");
    var selected = block.selected === "confirm" ? "confirm" : "cancel";

    var cancelBtnClass = selected === "cancel" ? "uk-button-primary" : "uk-button-default";
    var confirmBtnClass = selected === "confirm" ? "uk-button-primary" : "uk-button-danger";

    var html = '<div class="view-block block-confirm uk-card uk-card-default uk-card-body uk-card-small uk-border-rounded uk-margin-small-bottom" data-prompt-id="' + promptId + '">';
    html += '<p class="uk-text-bold uk-margin-small-bottom">' + message + "</p>";
    html += '<div class="uk-flex uk-flex-right" style="gap: 8px;">';
    html += '<button type="button" class="uk-button ' + cancelBtnClass + ' uk-button-small confirm-cancel-btn" data-action="cancel" data-prompt-id="' + promptId + '">' + cancelLabel + "</button>";
    html += '<button type="button" class="uk-button ' + confirmBtnClass + ' uk-button-small confirm-ok-btn" data-action="confirm" data-prompt-id="' + promptId + '">' + confirmLabel + "</button>";
    html += "</div></div>";
    return html;
  }

  function renderBlock(block) {
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
        return renderList(block);
      case "qr":
        return renderQr(block);
      case "status":
        return renderStatus(block);
      case "progress":
        return renderProgress(block);
      case "confirm":
        return renderConfirm(block);
      default:
        return renderFallback(block);
    }
  }

  function renderBlocks(blocks) {
    if (!Array.isArray(blocks)) return "";
    var out = "";
    for (var i = 0; i < blocks.length; i++) {
      out += renderBlock(blocks[i]);
    }
    return out;
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
  };
});

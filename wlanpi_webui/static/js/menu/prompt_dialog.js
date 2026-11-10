/**
 * MenuPromptDialog: one dialog for server-sent `prompt` frames on the menu
 * connection (select, confirm, integer, string, form).
 *
 * The dialog names the node that asked, shows the time left before the prompt
 * expires, traps focus while open and returns it on close. Esc and Cancel both
 * answer {cancel: true}. An answer carries exactly one of value, values,
 * confirmed or cancel.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./pages.js"));
  } else {
    root.MenuPromptDialog = factory(root.MenuPages);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Pages) {
  "use strict";

  var h = Pages.h;
  var FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  function fmtRemaining(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  /**
   * @param {Element} mount
   * @param {object} opts
   *   onAnswer(promptId, payload)   payload is one of {value}, {values}, {confirmed}, {cancel: true}
   *   onExpire(promptId)            the prompt ran out on screen
   *   describe(nodeId)              text naming the node that asked
   *   adapters()                    adapter names for adapter fields
   *   now / setInterval / clearInterval   injectable for tests
   */
  function create(mount, opts) {
    opts = opts || {};
    var doc = mount.ownerDocument;
    var now = opts.now || function () { return Date.now(); };
    var setIntervalFn = opts.setInterval || function (fn, ms) { return setInterval(fn, ms); };
    var clearIntervalFn = opts.clearInterval || function (id) { clearInterval(id); };

    var current = null; // { prompt, root, returnFocus, ticker, expiresAt }

    function focusables() {
      return current ? current.root.querySelectorAll(FOCUSABLE) : [];
    }

    function onKeydown(evt) {
      if (!current) return;
      if (evt.key === "Escape" || evt.key === "Esc") {
        evt.preventDefault();
        evt.stopPropagation();
        answer({ cancel: true });
        return;
      }
      if (evt.key !== "Tab") return;
      var items = focusables();
      if (!items.length) {
        evt.preventDefault();
        return;
      }
      var first = items[0];
      var last = items[items.length - 1];
      var active = doc.activeElement;
      if (evt.shiftKey && (active === first || !current.root.contains(active))) {
        evt.preventDefault();
        last.focus();
      } else if (!evt.shiftKey && (active === last || !current.root.contains(active))) {
        evt.preventDefault();
        first.focus();
      }
    }

    function answer(payload) {
      if (!current) return;
      var id = current.prompt.prompt_id;
      if (opts.onAnswer) opts.onAnswer(id, payload);
    }

    function readAnswer() {
      var p = current.prompt;
      var body = current.root.querySelector(".menu-dialog-body");
      if (p.kind === "confirm") return { confirmed: true };
      if (p.kind === "select") {
        var picked = body.querySelector('input[type="radio"]:checked');
        if (!picked) return { invalid: body.querySelector('input[type="radio"]') };
        return { value: p.options[parseInt(picked.value, 10)].value };
      }
      if (p.kind === "form") {
        var res = Pages.readFields(body, p.fields || []);
        return res.invalid ? res : { values: res.values };
      }
      var input = body.querySelector("[data-prompt-input]");
      if (typeof input.checkValidity === "function" && !input.checkValidity()) return { invalid: input };
      if (input.value === "") return { invalid: input };
      if (p.kind === "integer") {
        var n = Number(input.value);
        if (!isFinite(n) || Math.floor(n) !== n) return { invalid: input };
        return { value: n };
      }
      return { value: String(input.value) };
    }

    function onSubmit(evt) {
      evt.preventDefault();
      if (!current) return;
      var res = readAnswer();
      if (res.invalid) {
        if (typeof res.invalid.reportValidity === "function") res.invalid.reportValidity();
        if (typeof res.invalid.focus === "function") res.invalid.focus();
        return;
      }
      answer(res);
    }

    function buildBody(p) {
      var body = h(doc, "div.menu-dialog-body");
      if (p.message) body.appendChild(h(doc, "p.menu-dialog-message", { id: "menu-dialog-message", text: p.message }));
      var i;
      if (p.kind === "select") {
        var group = h(doc, "fieldset.uk-fieldset.menu-dialog-options", null, h(doc, "legend.visually-hidden", { text: p.title }));
        var options = Array.isArray(p.options) ? p.options : [];
        var preset = -1;
        for (i = 0; i < options.length; i++) {
          if (p.default !== undefined && JSON.stringify(options[i].value) === JSON.stringify(p.default)) preset = i;
        }
        if (preset === -1 && options.length) preset = 0;
        for (i = 0; i < options.length; i++) {
          var rid = "menu-prompt-opt-" + i;
          group.appendChild(h(doc, "label.menu-dialog-option", { "for": rid }, [
            h(doc, "input.uk-radio", { type: "radio", name: "menu-prompt-option", id: rid, value: String(i), checked: i === preset }),
            h(doc, "span.menu-dialog-option-label", { text: options[i].label }),
            options[i].detail ? [" ", h(doc, "span.menu-dialog-option-detail", { text: options[i].detail })] : null,
          ]));
        }
        body.appendChild(group);
      } else if (p.kind === "integer" || p.kind === "string") {
        var isInt = p.kind === "integer";
        body.appendChild(h(doc, "div.uk-margin-small", null, [
          h(doc, "label.uk-form-label", { "for": "menu-prompt-input", text: p.title }),
          h(doc, "input.uk-input.menu-ctl", {
            id: "menu-prompt-input", "data-prompt-input": "", type: isInt ? "number" : "text", required: true,
            inputmode: isInt ? "numeric" : null, step: isInt ? 1 : null, autocomplete: "off",
            min: isInt && typeof p.minimum === "number" ? p.minimum : null,
            max: isInt && typeof p.maximum === "number" ? p.maximum : null,
            value: p.default !== undefined && typeof p.default !== "object" ? p.default : null,
          }),
        ]));
      } else if (p.kind === "form") {
        var fields = Array.isArray(p.fields) ? p.fields : [];
        var adapters = opts.adapters ? opts.adapters() : [];
        for (i = 0; i < fields.length; i++) {
          body.appendChild(Pages.buildField(doc, fields[i], { adapters: adapters, prefix: "menu-prompt-" }));
        }
      }
      return body;
    }

    function tick() {
      if (!current || current.expiresAt === null) return;
      var left = (current.expiresAt - now()) / 1000;
      var el = current.root.querySelector(".menu-dialog-expiry");
      if (el) el.textContent = "Expires in " + fmtRemaining(left);
      if (left <= 0) {
        var id = current.prompt.prompt_id;
        close();
        if (opts.onExpire) opts.onExpire(id);
      }
    }

    /** Open the dialog for a prompt frame (replaces one that is already open). */
    function show(prompt) {
      if (current && current.prompt.prompt_id === prompt.prompt_id) return;
      var returnFocus = current ? current.returnFocus : doc.activeElement;
      if (current) teardown();

      var isConfirm = prompt.kind === "confirm";
      var asked = opts.describe && prompt.node ? opts.describe(prompt.node) : "";
      var heading = asked ? asked + ": " + prompt.title : prompt.title;
      var cancelLabel = isConfirm ? prompt.cancel_label || "Cancel" : "Cancel";
      var okLabel = isConfirm ? prompt.confirm_label || "Confirm" : "Continue";

      var form = h(doc, "form.uk-modal-dialog.uk-modal-body.menu-dialog-panel", {
        role: "dialog", "aria-modal": "true", "aria-labelledby": "menu-dialog-title",
        "aria-describedby": prompt.message ? "menu-dialog-message" : null, novalidate: "",
        "data-prompt-id": prompt.prompt_id, "data-kind": prompt.kind,
      }, [
        h(doc, "h3.uk-modal-title.menu-dialog-title", { id: "menu-dialog-title", text: heading }),
        buildBody(prompt),
        h(doc, "p.menu-dialog-error", { role: "alert", hidden: true }),
        h(doc, "div.menu-dialog-foot", null, [
          h(doc, "span.menu-dialog-expiry", { "aria-live": "off" }),
          h(doc, "span.menu-dialog-buttons", null, [
            h(doc, "button.uk-button.uk-button-default.menu-ctl", { type: "button", "data-prompt-cancel": "", text: cancelLabel }),
            h(doc, "button.uk-button.uk-button-primary", { type: "submit", "data-prompt-ok": "", text: okLabel }),
          ]),
        ]),
      ]);
      var rootEl = h(doc, "div.uk-modal.uk-open.menu-dialog", null, form);
      form.addEventListener("submit", onSubmit);
      rootEl.addEventListener("keydown", onKeydown);
      rootEl.querySelector("[data-prompt-cancel]").addEventListener("click", function () {
        answer({ cancel: true });
      });
      mount.appendChild(rootEl);

      var expiresAt = typeof prompt.expires_sec === "number"
        ? (typeof prompt.receivedAt === "number" ? prompt.receivedAt : now()) + prompt.expires_sec * 1000
        : null;
      current = { prompt: prompt, root: rootEl, returnFocus: returnFocus, ticker: null, expiresAt: expiresAt };
      if (expiresAt !== null) {
        current.ticker = setIntervalFn(tick, 1000);
        tick();
      }
      if (!current) return;

      // A confirmation opens on Cancel; everything else on its first control.
      var first = isConfirm
        ? rootEl.querySelector("[data-prompt-cancel]")
        : rootEl.querySelector('.menu-dialog-body input:checked, .menu-dialog-body input, .menu-dialog-body select') ||
          rootEl.querySelector("[data-prompt-cancel]");
      if (first) first.focus();
    }

    function teardown() {
      if (!current) return;
      if (current.ticker !== null) clearIntervalFn(current.ticker);
      if (current.root.parentNode) current.root.parentNode.removeChild(current.root);
      current = null;
    }

    /** Close without answering (answered, resolved elsewhere, expired). */
    function close() {
      if (!current) return;
      var back = current.returnFocus;
      teardown();
      if (back && back !== doc.body && typeof back.focus === "function" && doc.contains(back)) back.focus();
    }

    /** Show the server's refusal of an answer inside the dialog. */
    function showError(text) {
      if (!current) return;
      var el = current.root.querySelector(".menu-dialog-error");
      el.textContent = text || "";
      el.hidden = !text;
    }

    return {
      show: show,
      close: close,
      showError: showError,
      currentId: function () { return current ? current.prompt.prompt_id : null; },
      isOpen: function () { return Boolean(current); },
    };
  }

  return { create: create, fmtRemaining: fmtRemaining };
});

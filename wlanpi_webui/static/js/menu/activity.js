/**
 * MenuActivity: the "N running" chip in the page header and its popover.
 *
 * Shown only while something is running. Own jobs carry progress and Cancel
 * (when the node is cancellable); jobs started elsewhere on the device are
 * listed without controls.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./pages.js"), require("./router.js"));
  } else {
    root.MenuActivity = factory(root.MenuPages, root.MenuRouter);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Pages, Router) {
  "use strict";

  var h = Pages.h;

  /**
   * vm: { items: [{ jobId, node, label, own, pct, message, cancellable }], open, connected }
   */
  function render(el, vm) {
    var items = vm.items || [];
    Pages.patch(el, JSON.stringify([items, vm.open, vm.connected]), function () {
      var doc = el.ownerDocument;
      el.hidden = items.length === 0;
      if (!items.length) return;
      var open = Boolean(vm.open);
      el.appendChild(h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl.menu-activity-chip", {
        type: "button", "data-menu-action": "activity-toggle", "aria-expanded": open ? "true" : "false",
        "aria-controls": "menu-activity-list", "data-focus-key": "activity-chip",
      }, [h(doc, "span.menu-activity-dot", { "aria-hidden": "true" }), " " + items.length + " running"]));
      var drop = h(doc, "div.uk-drop.uk-card.uk-card-default.uk-card-body.uk-card-small.menu-activity-drop" + (open ? ".uk-open" : ""), {
        id: "menu-activity-list", role: "region", "aria-label": "Running jobs",
      });
      var ul = h(doc, "ul.menu-activity-list");
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var pct = typeof it.pct === "number" ? Math.max(0, Math.min(100, Math.round(it.pct))) : null;
        var li = h(doc, "li.menu-activity-item", { "data-job": it.jobId, "data-own": it.own ? "true" : "false" }, [
          h(doc, "div.menu-activity-head", null, [
            h(doc, "a", { href: Router.hrefFor(it.node), "data-menu-action": "activity-open", text: it.label || it.node }),
            pct === null ? null : h(doc, "span.menu-activity-pct", { text: pct + " %" }),
          ]),
        ]);
        if (it.own) {
          li.appendChild(h(doc, "div.menu-activity-row", null, [
            h(doc, "progress.uk-progress.menu-progress", {
              "aria-label": (it.label || it.node) + " progress", max: pct === null ? null : 100, value: pct,
            }),
            it.cancellable ? h(doc, "button.uk-button.uk-button-default.uk-button-small.menu-ctl", {
              type: "button", "data-menu-action": "cancel-job", "data-job": it.jobId, "data-node": it.node,
              "data-focus-key": "activity-cancel:" + it.jobId, disabled: !vm.connected, text: "Cancel",
            }) : null,
          ]));
          if (it.message) li.appendChild(h(doc, "p.menu-muted.menu-activity-note", { text: it.message }));
        } else {
          li.appendChild(h(doc, "p.menu-muted.menu-activity-note", { text: "started from another surface" }));
        }
        ul.appendChild(li);
      }
      drop.appendChild(ul);
      el.appendChild(drop);
    });
  }

  return { render: render };
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as H from "./helpers/harness.mjs";
import { boot } from "./helpers/app.mjs";

const { click, text, key, job } = H;

function prompt(extra) {
  return H.assertS2C({
    v: 1, type: "prompt", id: "s:p", prompt_id: "p001", job_id: "j001", node: "tools.survey", title: "Adapter",
    expires_sec: 120, ...extra,
  });
}

const OPTIONS = [
  { value: { iface: "wlan0", namespace: null }, label: "wlan0", detail: "root" },
  { value: { iface: "wlan1", namespace: "ns1" }, label: "wlan1", detail: "ns1" },
];

/** A running job on the Survey page that then asks something. */
function ask(extra, hash = "#tools.survey") {
  const c = boot({ hash });
  click(c.$('[data-menu-action="run"]'));
  c.ws.receive(job("tools.survey", "queued", { id: c.invokes()[0].id }));
  c.ws.receive(prompt(extra));
  return c;
}

/** Exactly one of value / values / confirmed / cancel. */
function answerOf(c) {
  const answers = c.sent("answer");
  assert.equal(answers.length, 1, "one answer frame");
  const a = answers[0];
  const kinds = ["value", "values", "confirmed", "cancel"].filter((k) => k in a);
  assert.equal(kinds.length, 1, `exactly one of value/values/confirmed/cancel, got ${kinds}`);
  assert.equal(a.prompt_id, "p001");
  return a;
}

describe("Prompt dialog: select", () => {
  it("is a dialog naming the node that asked, with a radio list of the options", () => {
    const c = ask({ kind: "select", options: OPTIONS, message: "Several adapters can scan. Pick one." });
    const dlg = c.$('[role="dialog"]');
    assert.ok(dlg);
    assert.equal(dlg.getAttribute("aria-modal"), "true");
    const title = c.document.getElementById(dlg.getAttribute("aria-labelledby"));
    assert.equal(text(title), "Tools › Survey: Adapter");
    assert.match(text(c.document.getElementById(dlg.getAttribute("aria-describedby"))), /Several adapters can scan/);
    const radios = Array.from(dlg.querySelectorAll('input[type="radio"]'));
    assert.equal(radios.length, 2);
    assert.deepEqual(Array.from(dlg.querySelectorAll(".menu-dialog-option")).map(text), ["wlan0 root", "wlan1 ns1"]);
    assert.equal(radios[0].checked, true);
    assert.equal(c.document.activeElement, radios[0], "focus moves into the dialog");
    assert.match(text(dlg.querySelector(".menu-dialog-expiry")), /^Expires in 2:00$/);
  });

  it("Continue answers with the chosen option's value and closes", () => {
    const c = ask({ kind: "select", options: OPTIONS });
    c.$('#menu-prompt-opt-1').checked = true;
    click(c.$("[data-prompt-ok]"));
    assert.deepEqual(answerOf(c).value, { iface: "wlan1", namespace: "ns1" });
    assert.equal(c.$('[role="dialog"]'), null);
    // The job carries on to its result on the action's own page.
    c.ws.receive(job("tools.survey", "result", { result: { blocks: [{ type: "text", text: "3 networks" }] } }));
    assert.match(text(c.$("#menu-result")), /3 networks/);
  });

  it("Esc and Cancel both answer cancel: true", () => {
    for (const how of ["esc", "button"]) {
      const c = ask({ kind: "select", options: OPTIONS });
      if (how === "esc") {
        key(c.document.activeElement, "Escape");
      } else {
        click(c.$("[data-prompt-cancel]"));
      }
      assert.equal(answerOf(c).cancel, true);
      assert.equal(c.$('[role="dialog"]'), null);
      c.ws.receive(job("tools.survey", "cancelled"));
      assert.match(text(c.$("#menu-result")), /^Cancelled at/);
    }
  });

  it("traps Tab inside the dialog and returns focus on close", () => {
    const c = boot({ hash: "#tools.survey" });
    const run = c.$('[data-menu-action="run"]');
    c.$('[data-param="adapter"]').focus();
    const opener = c.document.activeElement;
    click(run);
    c.ws.receive(job("tools.survey", "queued", { id: c.invokes()[0].id }));
    c.ws.receive(prompt({ kind: "select", options: OPTIONS }));
    const dlg = c.$('[role="dialog"]');
    const ok = c.$("[data-prompt-ok]");
    ok.focus();
    const forward = key(ok, "Tab");
    assert.equal(forward.defaultPrevented, true);
    assert.ok(dlg.contains(c.document.activeElement), "Tab from the last control wraps to the first");
    assert.notEqual(c.document.activeElement, ok);
    const first = c.document.activeElement;
    const back = key(first, "Tab", { shiftKey: true });
    assert.equal(back.defaultPrevented, true);
    assert.equal(c.document.activeElement, ok, "Shift+Tab from the first wraps to the last");
    click(c.$("[data-prompt-cancel]"));
    assert.equal(c.document.activeElement, opener, "focus returns to where it was");
  });
});

describe("Prompt dialog: confirm", () => {
  it("shows the message and labels, opens on Cancel, and answers confirmed: true", () => {
    const c = ask({ kind: "confirm", title: "Restart", message: "Restart the device now?", confirm_label: "Restart", cancel_label: "Not now" });
    assert.match(text(c.$(".menu-dialog-message")), /Restart the device now\?/);
    assert.equal(text(c.$("[data-prompt-cancel]")), "Not now");
    assert.equal(text(c.$("[data-prompt-ok]")), "Restart");
    assert.equal(c.document.activeElement, c.$("[data-prompt-cancel]"), "focus on Cancel");
    click(c.$("[data-prompt-ok]"));
    assert.equal(answerOf(c).confirmed, true);
  });

  it("Cancel on a confirmation answers cancel, never confirmed: false", () => {
    const c = ask({ kind: "confirm", title: "Restart", message: "Restart the device now?" });
    click(c.$("[data-prompt-cancel]"));
    const a = answerOf(c);
    assert.equal(a.cancel, true);
    assert.equal("confirmed" in a, false);
  });
});

describe("Prompt dialog: integer and string", () => {
  it("integer: number input with min, max and default; answers a number", () => {
    const c = ask({ kind: "integer", title: "Channel", minimum: 1, maximum: 165, default: 36 });
    const input = c.$("[data-prompt-input]");
    assert.equal(input.type, "number");
    assert.equal(input.getAttribute("min"), "1");
    assert.equal(input.getAttribute("max"), "165");
    assert.equal(input.value, "36");
    assert.equal(c.$('label[for="menu-prompt-input"]').textContent, "Channel");
    input.value = "999";
    click(c.$("[data-prompt-ok]"));
    assert.equal(c.sent("answer").length, 0, "out of range is not sent");
    assert.ok(c.$('[role="dialog"]'));
    input.value = "149";
    click(c.$("[data-prompt-ok]"));
    assert.strictEqual(answerOf(c).value, 149);
  });

  it("string: text input; answers a string; empty is not sent", () => {
    const c = ask({ kind: "string", title: "Name" });
    const input = c.$("[data-prompt-input]");
    assert.equal(input.type, "text");
    click(c.$("[data-prompt-ok]"));
    assert.equal(c.sent("answer").length, 0);
    input.value = "lab-ap";
    click(c.$("[data-prompt-ok]"));
    assert.strictEqual(answerOf(c).value, "lab-ap");
  });
});

describe("Prompt dialog: form", () => {
  it("one control per field; answers values by field name", () => {
    const c = ask({
      kind: "form", title: "Set Region", node: "sys.region",
      fields: [
        { name: "country", label: "Country", type: "enum", choices: [{ value: "US", label: "US" }, { value: "CZ", label: "CZ" }] },
        { name: "power", label: "Power", type: "integer", minimum: 1, maximum: 30, required: false },
        { name: "adapter", label: "Adapter", type: "adapter", kind: "wlan" },
      ],
    });
    const dlg = c.$('[role="dialog"]');
    assert.equal(text(c.$("#menu-dialog-title")), "Sys › Set Region: Set Region");
    assert.equal(dlg.querySelectorAll(".menu-field").length, 3);
    const country = dlg.querySelector('[data-param="country"]');
    const adapter = dlg.querySelector('[data-param="adapter"]');
    assert.equal(country.id, "menu-prompt-country", "ids do not collide with the page's form");
    click(c.$("[data-prompt-ok]"));
    assert.equal(c.sent("answer").length, 0, "a required field is missing");
    country.value = "1";
    adapter.value = "wlan1";
    click(c.$("[data-prompt-ok]"));
    assert.deepEqual(answerOf(c).values, { country: "CZ", adapter: { iface: "wlan1" } });
  });

  it("the recorded form prompt renders and answers", () => {
    const c = boot({ hash: "#net" });
    c.ws.receive({ ...H.sample("s2c", "prompt.form.json"), prompt_id: "p001" });
    const select = c.$('[role="dialog"] [data-param="country"]');
    select.value = "0";
    click(c.$("[data-prompt-ok]"));
    assert.deepEqual(answerOf(c).values, { country: "US" });
  });
});

describe("Prompt dialog: expiry and resolution elsewhere", () => {
  it("counts down from expires_sec and closes when it runs out", () => {
    const c = ask({ kind: "select", options: OPTIONS, expires_sec: 5 });
    assert.match(text(c.$(".menu-dialog-expiry")), /^Expires in 0:05$/);
    c.timers.advance(3000);
    assert.match(text(c.$(".menu-dialog-expiry")), /^Expires in 0:02$/);
    c.timers.advance(2000);
    assert.equal(c.$('[role="dialog"]'), null, "expired: closed");
    assert.equal(c.sent("answer").length, 0, "the server cancels an expired prompt itself");
    c.ws.receive(job("tools.survey", "cancelled"));
    assert.match(text(c.$("#menu-result")), /^Cancelled at/);
    assert.equal(c.timers.pending, 0, "the countdown timer is gone");
  });

  it("closes when the job ends elsewhere", () => {
    const c = ask({ kind: "select", options: OPTIONS });
    c.ws.receive(job("tools.survey", "cancelled"));
    assert.equal(c.$('[role="dialog"]'), null);
    assert.match(text(c.$("#menu-result")), /^Cancelled at/);
  });

  it("a refused answer reopens the prompt with the server's reason", () => {
    const c = ask({ kind: "integer", title: "Channel" });
    c.$("[data-prompt-input]").value = "7";
    click(c.$("[data-prompt-ok]"));
    c.ws.receive({ v: 1, type: "error", id: c.sent("answer")[0].id, code: "BAD_REQUEST", message: "channel: out of range" });
    assert.ok(c.$('[role="dialog"]'));
    assert.equal(c.$(".menu-dialog-error").hidden, false);
    assert.match(text(c.$(".menu-dialog-error")), /channel: out of range/);
  });

  it("a prompt for a job whose page the user has left still opens", () => {
    const c = boot({ hash: "#tools.survey" });
    click(c.$('[data-menu-action="run"]'));
    c.ws.receive(job("tools.survey", "queued", { id: c.invokes()[0].id }));
    c.go("#net");
    c.ws.receive(prompt({ kind: "select", options: OPTIONS }));
    assert.ok(c.$('[role="dialog"]'));
    assert.equal(text(c.$("#menu-dialog-title")), "Tools › Survey: Adapter");
  });

  it("answering while disconnected explains instead of failing silently", () => {
    const c = ask({ kind: "select", options: OPTIONS });
    c.ws.serverClose(1006);
    click(c.$("[data-prompt-ok]"));
    assert.equal(c.sent("answer").length, 0);
    assert.match(text(c.$(".menu-dialog-error")), /Not connected/);
  });
});

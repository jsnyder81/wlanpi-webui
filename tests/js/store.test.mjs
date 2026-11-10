import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  load, sample, SAMPLES, welcome, menuFrame, event, summaryEvent, job, tableBlock, rowsFrom, assertS2C,
} from "./helpers/harness.mjs";

const Store = load("menu/store.js");
const { STATUS } = Store;
const T0 = 1_700_000_000_000;

function fresh() {
  let s = Store.createState();
  s = Store.applyFrame(s, welcome(), T0);
  s = Store.applyFrame(s, menuFrame(), T0);
  return s;
}

describe("MenuStore.applyFrame over the recorded server frames", () => {
  const files = fs.readdirSync(path.join(SAMPLES, "s2c")).filter((f) => f.endsWith(".json"));

  it("reduces every recorded S-to-C sample without throwing and without mutating its input", () => {
    assert.ok(files.length >= 20, "samples found");
    let s = Store.createState();
    for (const f of files) {
      const frame = sample("s2c", f);
      const before = JSON.stringify(s);
      const next = Store.applyFrame(s, frame, T0);
      assert.equal(JSON.stringify(s), before, `${f}: applyFrame must not mutate the state it was given`);
      assert.ok(next && typeof next === "object", f);
      s = next;
    }
  });

  it("welcome.json and menu.json build the index", () => {
    let s = Store.applyFrame(Store.createState(), sample("s2c", "welcome.json"), T0);
    assert.equal(s.welcome.type, "welcome");
    s = Store.applyFrame(s, sample("s2c", "menu.json"), T0);
    const m = sample("s2c", "menu.json");
    assert.equal(s.menu.revision, m.revision);
    assert.equal(Object.keys(s.menu.byId).length, m.nodes.length);
    for (const n of m.nodes) assert.equal(Store.getNode(s, n.id).label, n.label);
  });

  it("view frames are not part of the menu connection and change nothing", () => {
    const s = fresh();
    for (const f of ["view.home.json", "view.menu.json", "view.mirror.json", "view.prompt-not-answerable.json"]) {
      assert.equal(Store.applyFrame(s, sample("s2c", f), T0), s);
    }
  });

  it("event samples land in their topic", () => {
    let s = fresh();
    s = Store.applyFrame(s, sample("s2c", "event.snapshot.json"), T0);
    s = Store.applyFrame(s, sample("s2c", "event.alerts.json"), T0);
    s = Store.applyFrame(s, sample("s2c", "event.jobs.json"), T0);
    assert.ok(Store.topic(s, sample("s2c", "event.snapshot.json").topic));
    assert.ok(Array.isArray(Store.topic(s, "alerts")));
    assert.ok(Array.isArray(Store.topic(s, "jobs")));
  });

  it("job samples walk queued -> progress -> result on one node", () => {
    let s = fresh();
    const queued = sample("s2c", "job.queued.json");
    s = Store.applyFrame(s, queued, T0);
    assert.equal(Store.resultFor(s, queued.node).status, STATUS.RUNNING);
    assert.ok(s.jobs[queued.job_id]);
    const progress = { ...sample("s2c", "job.progress.json"), job_id: queued.job_id, node: queued.node };
    s = Store.applyFrame(s, progress, T0);
    assert.deepEqual(Store.resultFor(s, queued.node).progress, progress.progress);
    const result = { ...sample("s2c", "job.result.json"), job_id: queued.job_id, node: queued.node };
    s = Store.applyFrame(s, result, T0 + 5);
    const r = Store.resultFor(s, queued.node);
    assert.equal(r.status, STATUS.RESULT);
    assert.deepEqual(r.data.blocks, result.result.blocks);
    assert.equal(r.data.at, T0 + 5);
    assert.equal(s.jobs[queued.job_id], undefined, "a finished job is no longer live");
  });

  it("job.error and job.cancelled samples set the error and cancelled states", () => {
    let s = fresh();
    const err = sample("s2c", "job.error.json");
    s = Store.applyFrame(s, err, T0);
    assert.equal(Store.resultFor(s, err.node).status, STATUS.ERROR);
    assert.deepEqual(Store.resultFor(s, err.node).error, err.error);
    const c = sample("s2c", "job.cancelled.json");
    s = Store.applyFrame(s, c, T0 + 1);
    assert.equal(Store.resultFor(s, c.node).status, STATUS.CANCELLED);
    assert.equal(Store.resultFor(s, c.node).at, T0 + 1);
  });

  it("prompt samples open the prompt; a second one queues", () => {
    let s = fresh();
    s = Store.applyFrame(s, sample("s2c", "prompt.select.json"), T0);
    assert.equal(s.prompt.kind, "select");
    assert.equal(s.prompt.receivedAt, T0);
    s = Store.applyFrame(s, sample("s2c", "prompt.confirm.json"), T0);
    assert.equal(s.prompt.kind, "select");
    assert.equal(s.promptQueue.length, 1);
    s = Store.closePrompt(s, s.prompt.prompt_id);
    assert.equal(s.prompt.kind, "confirm");
    s = Store.closePrompt(s, s.prompt.prompt_id);
    assert.equal(s.prompt, null);
  });

  it("error samples without a known request id leave the state alone", () => {
    const s = fresh();
    for (const f of ["error.auth.json", "error.conflict.json", "error.forbidden.json", "error.version.json"]) {
      assert.equal(Store.applyFrame(s, sample("s2c", f), T0), s, f);
    }
  });
});

describe("MenuStore menu index", () => {
  it("sorts siblings by order and exposes children and paths", () => {
    const s = fresh();
    assert.deepEqual(Store.childrenOf(s, "").map((n) => n.id), ["net", "tools", "sys"]);
    assert.deepEqual(Store.childrenOf(s, null).map((n) => n.id), ["net", "tools", "sys"]);
    assert.deepEqual(Store.childrenOf(s, "tools").map((n) => n.id),
      ["tools.survey", "tools.speed", "tools.radio_on", "tools.legacy", "tools.plugin", "tools.capture"]);
    assert.deepEqual(Store.pathTo(s, "tools.capture.more.start").map((n) => n.id),
      ["tools", "tools.capture", "tools.capture.more", "tools.capture.more.start"]);
    assert.deepEqual(Store.pathTo(s, "nope"), []);
    assert.deepEqual(Store.childrenOf(s, "sys.empty"), []);
  });

  it("orders by `order` whatever order the frame lists nodes in", () => {
    const m = menuFrame();
    const shuffled = { ...m, nodes: m.nodes.slice().reverse() };
    const s = Store.applyFrame(Store.createState(), shuffled, T0);
    assert.deepEqual(Store.childrenOf(s, "").map((n) => n.id), ["net", "tools", "sys"]);
  });

  it("a menu frame with a new revision replaces the tree", () => {
    let s = fresh();
    const m = menuFrame();
    const smaller = assertS2C({ ...m, revision: 2, device_mode: "hotspot", nodes: m.nodes.filter((n) => !n.id.startsWith("tools")) });
    s = Store.applyFrame(s, smaller, T0);
    assert.equal(s.menu.revision, 2);
    assert.equal(s.menu.deviceMode, "hotspot");
    assert.equal(Store.getNode(s, "tools.survey"), null);
    assert.deepEqual(Store.childrenOf(s, "").map((n) => n.id), ["net", "sys"]);
  });

  it("does not treat inherited object keys as nodes", () => {
    const s = fresh();
    assert.equal(Store.getNode(s, "constructor"), null);
    assert.equal(Store.getNode(s, "toString"), null);
  });
});

describe("MenuStore.runPolicy truth table", () => {
  const base = { id: "x", label: "X", parent: null, order: 1, kind: "action" };
  const params = [{ name: "n", label: "N", type: "string" }];
  const confirm = { message: "Sure?" };
  const cases = [
    [{ mutates: false }, "auto"],
    [{ mutates: true }, "run"],
    [{}, "run"], // mutates absent: treated as mutating
    [{ mutates: false, params }, "run"],
    [{ mutates: true, params }, "run"],
    [{ params }, "run"],
    [{ mutates: false, params: [] }, "auto"],
    [{ mutates: false, confirm }, "confirm"],
    [{ mutates: true, confirm }, "confirm"],
    [{ confirm }, "confirm"],
    [{ mutates: false, params, confirm }, "confirm"],
    [{ mutates: true, params, confirm }, "confirm"],
  ];
  for (const [extra, want] of cases) {
    it(`${JSON.stringify(Object.keys(extra).map((k) => k + "=" + (k === "mutates" ? extra[k] : "yes")))} -> ${want}`, () => {
      assert.equal(Store.runPolicy({ ...base, ...extra }), want);
    });
  }

  it("branches and unknown nodes have no policy", () => {
    assert.equal(Store.runPolicy({ ...base, kind: "branch" }), null);
    assert.equal(Store.runPolicy(null), null);
  });

  it("only an explicit mutates:false counts as read-only", () => {
    assert.equal(Store.isMutating({ ...base, mutates: false }), false);
    assert.equal(Store.isMutating({ ...base, mutates: true }), true);
    assert.equal(Store.isMutating({ ...base }), true);
    assert.equal(Store.isMutating({ ...base, kind: "branch" }), false);
  });

  it("matches the fixture menu", () => {
    const s = fresh();
    const p = (id) => Store.runPolicy(Store.getNode(s, id));
    assert.equal(p("net.ifaces"), "auto");
    assert.equal(p("tools.survey"), "run");
    assert.equal(p("tools.radio_on"), "run");
    assert.equal(p("tools.legacy"), "run");
    assert.equal(p("sys.restart"), "confirm");
    assert.equal(p("sys.region"), "run");
  });
});

describe("MenuStore requests and replies", () => {
  it("an invoke marks the node running at once and keeps the previous result", () => {
    let s = fresh();
    s = Store.applyFrame(s, job("net.ifaces", "result", { result: { blocks: [tableBlock(rowsFrom(0, 2))] } }), T0);
    s = Store.trackRequest(s, { id: "c5", kind: "invoke", node: "net.ifaces" });
    const r = Store.resultFor(s, "net.ifaces");
    assert.equal(r.status, STATUS.RUNNING);
    assert.equal(r.data.blocks[0].rows.length, 2, "the last result stays for an in-place refresh");
    assert.ok(Store.liveJobFor(s, "net.ifaces"), "counts as live before the server answers");
    s = Store.applyFrame(s, job("net.ifaces", "queued", { id: "c5", job_id: "j002" }), T0);
    assert.equal(s.pending.c5, undefined);
    assert.equal(Store.liveJobFor(s, "net.ifaces").jobId, "j002");
  });

  it("an error frame for an invoke is shown on that node, not globally", () => {
    let s = fresh();
    s = Store.trackRequest(s, { id: "c7", kind: "invoke", node: "tools.radio_on" });
    const err = { ...sample("s2c", "error.forbidden.json"), id: "c7" };
    s = Store.applyFrame(s, err, T0);
    const r = Store.resultFor(s, "tools.radio_on");
    assert.equal(r.status, STATUS.ERROR);
    assert.equal(r.error.code, "FORBIDDEN");
    assert.equal(Store.liveJobFor(s, "tools.radio_on"), null);
  });

  it("a page reply appends rows to the same table and moves the cursor", () => {
    let s = fresh();
    s = Store.applyFrame(s, job("tools.survey", "result", {
      result: { blocks: [tableBlock(rowsFrom(0, 20))], cursor: "cAAA", total: 45 },
    }), T0);
    assert.equal(Store.resultFor(s, "tools.survey").data.shown, 20);
    s = Store.trackRequest(s, { id: "c9", kind: "page", node: "tools.survey", jobId: "j001" });
    assert.equal(Store.resultFor(s, "tools.survey").paging, true);
    s = Store.applyFrame(s, job("tools.survey", "result", {
      id: "c9", result: { blocks: [tableBlock(rowsFrom(20, 20))], cursor: "cBBB", total: 45 },
    }), T0 + 9);
    let d = Store.resultFor(s, "tools.survey").data;
    assert.equal(d.blocks.length, 1, "same columns: one table");
    assert.equal(d.blocks[0].rows.length, 40);
    assert.equal(d.shown, 40);
    assert.equal(d.cursor, "cBBB");
    assert.equal(d.at, T0, "paging does not change when the result was taken");
    assert.equal(Store.resultFor(s, "tools.survey").paging, false);
    s = Store.trackRequest(s, { id: "c10", kind: "page", node: "tools.survey", jobId: "j001" });
    s = Store.applyFrame(s, job("tools.survey", "result", {
      id: "c10", result: { blocks: [tableBlock(rowsFrom(40, 5))], cursor: null, total: 45 },
    }), T0);
    d = Store.resultFor(s, "tools.survey").data;
    assert.equal(d.blocks[0].rows.length, 45);
    assert.equal(d.cursor, null, "last page: no cursor");
  });

  it("a page with different columns is appended as its own block", () => {
    const a = [tableBlock(rowsFrom(0, 2))];
    const b = [tableBlock([["x"]], [{ key: "other", label: "Other" }]), { type: "text", text: "tail" }];
    const out = Store.appendBlocks(a, b);
    assert.equal(out.length, 3);
    assert.equal(a[0].rows.length, 2, "inputs untouched");
  });

  it("caps appended rows at 1,000 by dropping the oldest and says how many", () => {
    let s = fresh();
    s = Store.applyFrame(s, job("tools.survey", "result", {
      result: { blocks: [tableBlock(rowsFrom(0, 500))], cursor: "c1", total: 1500 },
    }), T0);
    for (let page = 1; page < 3; page++) {
      s = Store.trackRequest(s, { id: "p" + page, kind: "page", node: "tools.survey", jobId: "j001" });
      s = Store.applyFrame(s, job("tools.survey", "result", {
        id: "p" + page, result: { blocks: [tableBlock(rowsFrom(page * 500, 500))], cursor: page < 2 ? "c" + (page + 1) : null, total: 1500 },
      }), T0);
    }
    const d = Store.resultFor(s, "tools.survey").data;
    assert.equal(Store.countRows(d.blocks), Store.MAX_ROWS);
    assert.equal(Store.MAX_ROWS, 1000);
    assert.equal(d.dropped, 500);
    assert.equal(d.shown, 1500);
    assert.equal(d.blocks[0].rows[0][0], "row500", "the oldest page went first");
  });

  it("a refused page keeps the result and records the error on it", () => {
    let s = fresh();
    s = Store.applyFrame(s, job("tools.survey", "result", { result: { blocks: [tableBlock(rowsFrom(0, 2))], cursor: "c1" } }), T0);
    s = Store.trackRequest(s, { id: "c3", kind: "page", node: "tools.survey", jobId: "j001" });
    s = Store.applyFrame(s, { v: 1, type: "error", id: "c3", code: "NOT_FOUND", message: "unknown cursor" }, T0);
    const r = Store.resultFor(s, "tools.survey");
    assert.equal(r.status, STATUS.RESULT);
    assert.equal(r.pageError.code, "NOT_FOUND");
    assert.equal(r.data.blocks[0].rows.length, 2);
  });

  it("a cancel reply ends the job as cancelled", () => {
    let s = fresh();
    s = Store.applyFrame(s, job("tools.speed", "progress", { progress: { pct: 40 } }), T0);
    s = Store.trackRequest(s, { id: "c4", kind: "cancel", node: "tools.speed", jobId: "j001" });
    s = Store.applyFrame(s, job("tools.speed", "cancelled", { id: "c4" }), T0 + 3);
    assert.equal(Store.resultFor(s, "tools.speed").status, STATUS.CANCELLED);
    assert.equal(Store.liveJobFor(s, "tools.speed"), null);
    assert.deepEqual(s.jobs, {});
  });

  it("a prompt closes when its job ends elsewhere (expired or resolved)", () => {
    let s = fresh();
    s = Store.applyFrame(s, job("tools.survey", "queued"), T0);
    s = Store.applyFrame(s, assertS2C({
      v: 1, type: "prompt", id: "s:9", prompt_id: "p001", job_id: "j001", node: "tools.survey", kind: "select",
      title: "Adapter", options: [{ value: { iface: "wlan0" }, label: "wlan0" }], expires_sec: 120,
    }), T0);
    assert.equal(s.prompt.prompt_id, "p001");
    s = Store.applyFrame(s, job("tools.survey", "cancelled"), T0);
    assert.equal(s.prompt, null);
    assert.equal(Store.resultFor(s, "tools.survey").status, STATUS.CANCELLED);
  });

  it("a refused answer puts the prompt back with the reason; NOT_FOUND does not", () => {
    let s = fresh();
    const prompt = assertS2C({ v: 1, type: "prompt", id: "s:9", prompt_id: "p001", job_id: "j001", node: "sys.region", kind: "integer", title: "Power" });
    s = Store.applyFrame(s, prompt, T0);
    s = Store.trackRequest(s, { id: "c8", kind: "answer", promptId: "p001", prompt: s.prompt });
    s = Store.closePrompt(s, "p001");
    assert.equal(s.prompt, null);
    const refused = Store.applyFrame(s, { v: 1, type: "error", id: "c8", code: "BAD_REQUEST", message: "power: out of range" }, T0);
    assert.equal(refused.prompt.prompt_id, "p001");
    assert.equal(refused.promptError.message, "power: out of range");
    const gone = Store.applyFrame(s, { v: 1, type: "error", id: "c8", code: "NOT_FOUND", message: "unknown or already answered prompt" }, T0);
    assert.equal(gone.prompt, null);
  });
});

describe("MenuStore bounds", () => {
  it("keeps the last result for at most 20 nodes, least recently written first out", () => {
    let s = fresh();
    for (let i = 0; i < 30; i++) {
      s = Store.applyFrame(s, job("node" + i, "result", { job_id: "j00" + i, result: { blocks: [{ type: "text", text: "r" + i }] } }), T0 + i);
    }
    assert.equal(Object.keys(s.results).length, Store.RESULT_LRU);
    assert.equal(Store.RESULT_LRU, 20);
    assert.equal(Store.resultFor(s, "node0"), null);
    assert.equal(Store.resultFor(s, "node9"), null);
    assert.ok(Store.resultFor(s, "node10"));
    assert.ok(Store.resultFor(s, "node29"));
    assert.equal(s.resultOrder.length, 20);
  });

  it("never evicts a running node", () => {
    let s = fresh();
    s = Store.applyFrame(s, job("slow", "progress", { job_id: "jslow", progress: { pct: null } }), T0);
    for (let i = 0; i < 40; i++) {
      s = Store.applyFrame(s, job("node" + i, "result", { job_id: "j00" + i, result: { blocks: [] } }), T0);
    }
    assert.equal(Store.resultFor(s, "slow").status, STATUS.RUNNING);
    assert.ok(Object.keys(s.results).length <= Store.RESULT_LRU + 1);
  });

  it("100 invokes of the same node leave the state the same size", () => {
    let s = fresh();
    const sizes = [];
    for (let i = 0; i < 100; i++) {
      s = Store.trackRequest(s, { id: "c" + i, kind: "invoke", node: "net.ifaces" });
      s = Store.applyFrame(s, job("net.ifaces", "queued", { id: "c" + i, job_id: "j00" + i }), T0 + i);
      s = Store.applyFrame(s, job("net.ifaces", "progress", { job_id: "j00" + i, progress: { pct: null, message: "Running" } }), T0 + i);
      s = Store.applyFrame(s, job("net.ifaces", "result", { job_id: "j00" + i, result: { blocks: [tableBlock(rowsFrom(0, 3))] } }), T0 + i);
      sizes.push(JSON.stringify(s).length);
    }
    assert.equal(Object.keys(s.results).length, 1);
    assert.deepEqual(s.jobs, {});
    assert.deepEqual(s.pending, {});
    assert.equal(s.resultOrder.length, 1);
    // Job ids grow by a digit; nothing else may.
    assert.ok(sizes[99] - sizes[10] <= 4, `state grew from ${sizes[10]} to ${sizes[99]} bytes`);
  });
});

describe("MenuStore pending requests stay bounded", () => {
  it("answers, which get no reply when accepted, do not accumulate", () => {
    let s = fresh();
    for (let i = 0; i < 50; i++) {
      const p = assertS2C({ v: 1, type: "prompt", id: "s:9", prompt_id: "p00" + i, job_id: "j00" + i, node: "tools.survey", kind: "string", title: "Name" });
      s = Store.applyFrame(s, p, T0);
      s = Store.trackRequest(s, { id: "a" + i, kind: "answer", promptId: p.prompt_id, prompt: s.prompt });
      s = Store.closePrompt(s, p.prompt_id);
    }
    assert.ok(Object.keys(s.pending).length <= 4, `pending: ${Object.keys(s.pending).length}`);
    assert.ok(s.pending.a49, "the newest answer can still be refused");
    // Other request kinds are not touched by that pruning.
    s = Store.trackRequest(s, { id: "c1", kind: "invoke", node: "net.ifaces" });
    s = Store.trackRequest(s, { id: "a50", kind: "answer", promptId: "p0050", prompt: null });
    assert.ok(s.pending.c1);
  });
});

describe("MenuStore topics and reconnect", () => {
  it("a seq gap without a snapshot marks the topic stale until the next snapshot", () => {
    let s = fresh();
    s = Store.applyFrame(s, summaryEvent(1), T0);
    assert.equal(s.topics["device.summary"].stale, false);
    s = Store.applyFrame(s, event("device.summary", 2, { hostname: "b" }), T0);
    assert.equal(s.topics["device.summary"].stale, false, "seq + 1 is in order");
    s = Store.applyFrame(s, event("device.summary", 5, { hostname: "c" }), T0);
    assert.equal(s.topics["device.summary"].stale, true, "gap");
    s = Store.applyFrame(s, event("device.summary", 6, { hostname: "d" }), T0);
    assert.equal(s.topics["device.summary"].stale, true, "still stale: no snapshot yet");
    s = Store.applyFrame(s, event("device.summary", 7, { hostname: "e" }, { snapshot: true }), T0 + 1);
    assert.equal(s.topics["device.summary"].stale, false);
    assert.equal(Store.topic(s, "device.summary").hostname, "e");
    assert.equal(s.topics["device.summary"].at, T0 + 1);
  });

  it("core unavailable is a device.summary value, not a connection state", () => {
    let s = fresh();
    assert.equal(Store.coreUnavailable(s), false);
    s = Store.applyFrame(s, event("device.summary", 1, { core: "unavailable" }, { snapshot: true }), T0);
    assert.equal(Store.coreUnavailable(s), true);
  });

  it("resumed: true keeps everything", () => {
    let s = fresh();
    s = Store.applyFrame(s, summaryEvent(1), T0);
    s = Store.applyFrame(s, job("tools.speed", "progress", { progress: { pct: 10 } }), T0);
    const next = Store.applyFrame(s, welcome({ resumed: true }), T0);
    assert.deepEqual(next.jobs, s.jobs);
    assert.equal(next.menu, s.menu);
    assert.equal(next.topics, s.topics);
    assert.equal(Store.resultFor(next, "tools.speed").status, STATUS.RUNNING);
  });

  it("resumed: false drops live jobs, then adopts the job frames the server sends", () => {
    let s = fresh();
    s = Store.applyFrame(s, summaryEvent(1), T0);
    s = Store.applyFrame(s, job("net.ifaces", "result", { job_id: "j000", result: { blocks: [tableBlock(rowsFrom(0, 2))], cursor: "cX" } }), T0);
    s = Store.trackRequest(s, { id: "c2", kind: "invoke", node: "net.ifaces" });
    s = Store.applyFrame(s, job("tools.speed", "progress", { job_id: "j005", progress: { pct: 10 } }), T0);
    s = Store.applyFrame(s, job("tools.radio_on", "queued", { job_id: "j006" }), T0);
    s = Store.applyFrame(s, assertS2C({ v: 1, type: "prompt", id: "s:9", prompt_id: "p001", job_id: "j006", node: "tools.radio_on", kind: "confirm", title: "Sure?" }), T0);

    s = Store.applyFrame(s, welcome({ resumed: false, epoch: "epoch-0002", session_id: "sess-0002" }), T0 + 10);
    assert.deepEqual(s.jobs, {}, "nothing is assumed live");
    assert.deepEqual(s.pending, {});
    assert.equal(s.prompt, null);
    assert.equal(Store.resultFor(s, "tools.speed"), null, "a running job without a result is forgotten");
    const kept = Store.resultFor(s, "net.ifaces");
    assert.equal(kept.status, STATUS.RESULT, "the last result stays on screen");
    assert.equal(kept.data.cursor, null, "its cursor belonged to the old connection");
    assert.equal(kept.data.cursorLost, true);
    assert.equal(s.topics["device.summary"].stale, true);
    assert.ok(s.menu, "the menu stays until the snapshot replaces it");

    // Snapshot: the server re-sends live jobs.
    s = Store.applyFrame(s, job("tools.speed", "progress", { job_id: "j005", progress: { pct: 60 } }), T0 + 11);
    assert.equal(Store.liveJobFor(s, "tools.speed").jobId, "j005");
    assert.equal(Store.resultFor(s, "tools.speed").progress.pct, 60);
    s = Store.applyFrame(s, summaryEvent(1), T0 + 11);
    assert.equal(s.topics["device.summary"].stale, false);
  });

  it("activity lists own jobs with progress and other surfaces' jobs without", () => {
    let s = fresh();
    s = Store.applyFrame(s, job("tools.speed", "progress", { job_id: "j005", progress: { pct: 40 } }), T0);
    s = Store.applyFrame(s, event("jobs", 1, [
      { job_id: "j005", node: "tools.speed", state: "progress", sessions: 1 },
      { job_id: "j009", node: "tools.capture.more.start", state: "progress", sessions: 1 },
    ], { snapshot: true }), T0);
    assert.deepEqual(Store.activity(s), [
      { jobId: "j005", node: "tools.speed", own: true, progress: { pct: 40 } },
      { jobId: "j009", node: "tools.capture.more.start", own: false, progress: null },
    ]);
  });
});

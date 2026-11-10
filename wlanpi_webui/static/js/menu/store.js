/**
 * MenuStore: the menu page's state and the pure reducers over it.
 *
 * No DOM and no I/O. `applyFrame(state, frame, now)` takes a server frame and
 * returns the next state; `trackRequest` records a request the client sent so
 * its reply can be routed. The server owns the menu: this file only indexes
 * the nodes it is sent (by id, by parent, ordered by `order`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MenuStore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var RESULT_LRU = 20;
  var MAX_ROWS = 1000;
  var MAX_PENDING_ANSWERS = 4;
  var ROOT = "";

  var STATUS = {
    RUNNING: "running",
    RESULT: "result",
    ERROR: "error",
    CANCELLED: "cancelled",
  };

  function createState() {
    return {
      welcome: null,
      menu: null, // { revision, deviceMode, byId, children }
      topics: {}, // topic -> { data, seq, stale, at }
      jobs: {}, // job_id -> { jobId, node, state, progress, shared } (own live jobs)
      results: {}, // node id -> result entry
      resultOrder: [], // node ids, least recently written first
      pending: {}, // request id -> { kind, node, jobId, promptId }
      prompt: null, // the open prompt frame (+ receivedAt)
      promptQueue: [],
      promptError: null,
    };
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  function clone(state) {
    return assign({}, state);
  }

  function without(obj, key) {
    var out = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && k !== key) out[k] = obj[k];
    }
    return out;
  }

  // ---------------------------------------------------------------- menu

  function indexMenu(frame) {
    var byId = {};
    var children = {};
    var nodes = Array.isArray(frame.nodes) ? frame.nodes : [];
    var i;
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n && typeof n.id === "string") byId[n.id] = n;
    }
    for (var id in byId) {
      var parent = byId[id].parent;
      var key = typeof parent === "string" && byId[parent] ? parent : ROOT;
      // A node whose parent was not sent is unreachable by drilling; the
      // server already removed hidden nodes, so only attach to known parents.
      if (typeof parent === "string" && !byId[parent]) continue;
      (children[key] = children[key] || []).push(id);
    }
    for (var p in children) {
      children[p].sort(function (a, b) {
        var oa = byId[a].order;
        var ob = byId[b].order;
        if (oa !== ob) return oa - ob;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }
    return {
      revision: frame.revision,
      deviceMode: frame.device_mode || null,
      byId: byId,
      children: children,
    };
  }

  function getNode(state, id) {
    return state.menu && Object.prototype.hasOwnProperty.call(state.menu.byId, id) ? state.menu.byId[id] : null;
  }

  /** Child nodes of `parentId` ("" or null for the root), in server order. */
  function childrenOf(state, parentId) {
    if (!state.menu) return [];
    var ids = state.menu.children[parentId || ROOT] || [];
    var out = [];
    for (var i = 0; i < ids.length; i++) out.push(state.menu.byId[ids[i]]);
    return out;
  }

  /** Nodes from the top-level ancestor down to `id` (inclusive). Empty if unknown. */
  function pathTo(state, id) {
    var out = [];
    var seen = {};
    var cur = getNode(state, id);
    while (cur && !seen[cur.id]) {
      seen[cur.id] = true;
      out.unshift(cur);
      cur = typeof cur.parent === "string" ? getNode(state, cur.parent) : null;
    }
    return out;
  }

  /**
   * How an action starts:
   *   "auto"    read-only, no parameters, no confirmation: runs on arrival
   *   "run"     waits for the Run button
   *   "confirm" waits for Run, then an inline confirmation
   * A node without `mutates` is treated as mutating. Branches have no policy.
   */
  function runPolicy(node) {
    if (!node || node.kind !== "action") return null;
    if (node.confirm) return "confirm";
    var hasParams = Array.isArray(node.params) && node.params.length > 0;
    if (node.mutates === false && !hasParams) return "auto";
    return "run";
  }

  function isMutating(node) {
    return Boolean(node) && node.kind === "action" && node.mutates !== false;
  }

  // ---------------------------------------------------------------- results

  function rowsOf(block) {
    if (!block || typeof block !== "object") return 1;
    if (block.type === "table" && Array.isArray(block.rows)) return block.rows.length;
    if ((block.type === "list" || block.type === "kv") && Array.isArray(block.items)) return block.items.length;
    return 1;
  }

  function countRows(blocks) {
    var n = 0;
    for (var i = 0; i < blocks.length; i++) n += rowsOf(blocks[i]);
    return n;
  }

  function sameColumns(a, b) {
    if (!a || !b || a.type !== "table" || b.type !== "table") return false;
    if (!Array.isArray(a.columns) || !Array.isArray(b.columns) || a.columns.length !== b.columns.length) return false;
    for (var i = 0; i < a.columns.length; i++) {
      if (a.columns[i].key !== b.columns[i].key) return false;
    }
    return true;
  }

  /** Append a page of blocks: rows join the last table when the columns match. */
  function appendBlocks(existing, more) {
    var out = existing.slice();
    for (var i = 0; i < more.length; i++) {
      var b = more[i];
      var last = out[out.length - 1];
      if (sameColumns(last, b)) {
        out[out.length - 1] = assign({}, last, {
          rows: last.rows.concat(b.rows),
          text: [last.text, b.text].filter(Boolean).join("\n"),
        });
      } else {
        out.push(b);
      }
    }
    return out;
  }

  /** Keep at most MAX_ROWS rows by dropping the oldest. Returns { blocks, dropped }. */
  function capRows(blocks, max) {
    var total = countRows(blocks);
    var dropped = 0;
    var out = blocks.slice();
    while (total > max && out.length) {
      var first = out[0];
      var n = rowsOf(first);
      var excess = total - max;
      if (first.type === "table" && n > excess) {
        out[0] = assign({}, first, { rows: first.rows.slice(excess) });
        dropped += excess;
        total -= excess;
      } else if (out.length > 1) {
        out.shift();
        dropped += n;
        total -= n;
      } else {
        break;
      }
    }
    return { blocks: out, dropped: dropped };
  }

  function touchResult(state, nodeId, entry) {
    var results = assign({}, state.results);
    var order = state.resultOrder.filter(function (id) { return id !== nodeId; });
    results[nodeId] = entry;
    order.push(nodeId);
    // Evict the least recently written results; a running one is never evicted.
    var i = 0;
    while (order.length > RESULT_LRU && i < order.length) {
      var victim = order[i];
      if (victim !== nodeId && results[victim] && results[victim].status !== STATUS.RUNNING) {
        delete results[victim];
        order.splice(i, 1);
      } else {
        i += 1;
      }
    }
    state.results = results;
    state.resultOrder = order;
  }

  function dropResult(state, nodeId) {
    if (!state.results[nodeId]) return;
    state.results = without(state.results, nodeId);
    state.resultOrder = state.resultOrder.filter(function (id) { return id !== nodeId; });
  }

  function resultFor(state, nodeId) {
    return state.results[nodeId] || null;
  }

  function liveJobFor(state, nodeId) {
    for (var id in state.jobs) {
      if (state.jobs[id].node === nodeId) return state.jobs[id];
    }
    var r = state.results[nodeId];
    // An invoke that has not been answered yet also counts as live.
    return r && r.status === STATUS.RUNNING ? { jobId: r.jobId || null, node: nodeId, state: "queued", progress: null } : null;
  }

  // ---------------------------------------------------------------- frames

  function applyWelcome(state, frame) {
    var next = clone(state);
    next.welcome = frame;
    if (!frame.resumed) {
      // Nothing held is known to be current. The snapshot that follows
      // restores the menu and topics; `job` frames re-adopt live jobs.
      var results = assign({}, state.results);
      var order = state.resultOrder.slice();
      for (var nodeId in results) {
        var r = results[nodeId];
        if (r.status !== STATUS.RUNNING) continue;
        if (r.data) {
          results[nodeId] = assign({}, r, { status: STATUS.RESULT, jobId: null, progress: null });
        } else {
          delete results[nodeId];
          order = order.filter(function (id) { return id !== nodeId; });
        }
      }
      // A finished job belongs to the old session: its cursor can no longer be paged.
      for (var id2 in results) {
        var d = results[id2].data;
        if (d && d.cursor) results[id2] = assign({}, results[id2], { data: assign({}, d, { cursor: null, cursorLost: true }) });
      }
      next.results = results;
      next.resultOrder = order;
      next.jobs = {};
      next.pending = {};
      next.prompt = null;
      next.promptQueue = [];
      next.promptError = null;
      var topics = {};
      for (var t in state.topics) topics[t] = assign({}, state.topics[t], { stale: true });
      next.topics = topics;
    }
    return next;
  }

  function applyMenu(state, frame) {
    var next = clone(state);
    next.menu = indexMenu(frame);
    return next;
  }

  function applyEvent(state, frame, now) {
    var next = clone(state);
    var prev = state.topics[frame.topic];
    var gap = !frame.snapshot && prev && typeof prev.seq === "number" && frame.seq !== prev.seq + 1;
    var stale = frame.snapshot ? false : Boolean(gap || (prev && prev.stale));
    next.topics = assign({}, state.topics);
    next.topics[frame.topic] = { data: frame.data, seq: frame.seq, stale: stale, at: now };
    return next;
  }

  function closePromptsForJob(next, jobId) {
    if (next.prompt && next.prompt.job_id === jobId) {
      next.prompt = next.promptQueue.length ? next.promptQueue[0] : null;
      next.promptQueue = next.promptQueue.slice(1);
      next.promptError = null;
    }
    if (next.promptQueue.length) {
      next.promptQueue = next.promptQueue.filter(function (p) { return p.job_id !== jobId; });
    }
  }

  function applyPage(next, frame, pend, now) {
    var entry = next.results[pend.node];
    if (!entry || !entry.data || entry.data.jobId !== frame.job_id || !frame.result) return;
    var page = Array.isArray(frame.result.blocks) ? frame.result.blocks : [];
    var merged = capRows(appendBlocks(entry.data.blocks, page), MAX_ROWS);
    var data = assign({}, entry.data, {
      blocks: merged.blocks,
      cursor: frame.result.cursor || null,
      shown: entry.data.shown + countRows(page),
      dropped: (entry.data.dropped || 0) + merged.dropped,
      pagedAt: now,
    });
    if (typeof frame.result.total === "number") data.total = frame.result.total;
    touchResult(next, pend.node, assign({}, entry, { data: data, pageError: null, paging: false }));
  }

  function applyJob(state, frame, now) {
    var next = clone(state);
    var pend = state.pending[frame.id];
    if (pend) next.pending = without(state.pending, frame.id);

    if (pend && pend.kind === "page") {
      applyPage(next, frame, pend, now);
      return next;
    }

    var nodeId = frame.node;
    var prev = state.results[nodeId] || null;
    var live = frame.state === "queued" || frame.state === "progress";
    if (live) {
      next.jobs = assign({}, state.jobs);
      next.jobs[frame.job_id] = {
        jobId: frame.job_id, node: nodeId, state: frame.state,
        progress: frame.progress || null, shared: Boolean(frame.shared),
      };
      touchResult(next, nodeId, {
        status: STATUS.RUNNING, jobId: frame.job_id, progress: frame.progress || null,
        data: prev ? prev.data : null, error: null, at: prev ? prev.at : null,
      });
      return next;
    }

    if (state.jobs[frame.job_id]) next.jobs = without(state.jobs, frame.job_id);
    closePromptsForJob(next, frame.job_id);

    if (frame.state === "result") {
      var res = frame.result || {};
      var blocks = Array.isArray(res.blocks) ? res.blocks : [];
      touchResult(next, nodeId, {
        status: STATUS.RESULT, jobId: frame.job_id, progress: null, error: null, at: now,
        data: {
          jobId: frame.job_id,
          title: typeof res.title === "string" ? res.title : null,
          blocks: blocks,
          cursor: res.cursor || null,
          total: typeof res.total === "number" ? res.total : null,
          shown: countRows(blocks),
          dropped: 0,
          shared: Boolean(frame.shared),
          cachedAt: frame.cached_at || null,
          at: now,
        },
      });
    } else if (frame.state === "error") {
      touchResult(next, nodeId, {
        status: STATUS.ERROR, jobId: frame.job_id, progress: null, data: null, at: now,
        error: frame.error || { code: "INTERNAL", message: "" },
      });
    } else if (frame.state === "cancelled") {
      touchResult(next, nodeId, {
        status: STATUS.CANCELLED, jobId: frame.job_id, progress: null, error: null, at: now,
        data: prev ? prev.data : null,
      });
    }
    return next;
  }

  function applyPrompt(state, frame, now) {
    var next = clone(state);
    var p = assign({}, frame, { receivedAt: now });
    if (state.prompt && state.prompt.prompt_id !== frame.prompt_id) {
      next.promptQueue = state.promptQueue.concat([p]);
    } else {
      next.prompt = p;
      next.promptError = null;
    }
    return next;
  }

  function applyError(state, frame, now) {
    var pend = state.pending[frame.id];
    if (!pend) return state;
    var next = clone(state);
    next.pending = without(state.pending, frame.id);
    var err = { code: frame.code, message: frame.message || "" };
    if (pend.kind === "invoke") {
      touchResult(next, pend.node, { status: STATUS.ERROR, jobId: null, progress: null, data: null, error: err, at: now });
    } else if (pend.kind === "page") {
      var entry = next.results[pend.node];
      if (entry) touchResult(next, pend.node, assign({}, entry, { pageError: err, paging: false }));
    } else if (pend.kind === "answer") {
      // The dialog closed when the answer was sent. NOT_FOUND means the prompt
      // was answered or expired elsewhere; any other refusal leaves the prompt
      // open on the server, so put it back with the reason.
      if (frame.code !== "NOT_FOUND" && pend.prompt) {
        if (next.prompt && next.prompt.prompt_id !== pend.prompt.prompt_id) {
          next.promptQueue = [next.prompt].concat(next.promptQueue);
        }
        next.prompt = pend.prompt;
        next.promptError = err;
      }
    }
    return next;
  }

  /** Reduce one server frame. `view` frames are not part of this connection and are ignored. */
  function applyFrame(state, frame, now) {
    if (!frame || typeof frame !== "object") return state;
    if (typeof now !== "number") now = Date.now();
    switch (frame.type) {
      case "welcome": return applyWelcome(state, frame);
      case "menu": return applyMenu(state, frame);
      case "event": return applyEvent(state, frame, now);
      case "job": return applyJob(state, frame, now);
      case "prompt": return applyPrompt(state, frame, now);
      case "error": return applyError(state, frame, now);
      default: return state;
    }
  }

  /**
   * Record a request the client just sent.
   *   { id, kind: "invoke", node }            marks the node running at once
   *   { id, kind: "page", node, jobId }
   *   { id, kind: "cancel", node, jobId }
   *   { id, kind: "answer", promptId, prompt }   prompt: the frame being answered
   */
  function trackRequest(state, req) {
    var next = clone(state);
    next.pending = assign({}, state.pending);
    next.pending[req.id] = {
      kind: req.kind, node: req.node || null, jobId: req.jobId || null, promptId: req.promptId || null,
      prompt: req.prompt || null,
    };
    if (req.kind === "answer") {
      // An accepted answer has no reply of its own, so nothing ever clears
      // it: keep only the few most recent to route a refusal.
      var answers = [];
      for (var rid in next.pending) {
        if (next.pending[rid].kind === "answer") answers.push(rid);
      }
      while (answers.length > MAX_PENDING_ANSWERS) delete next.pending[answers.shift()];
    }
    if (req.kind === "invoke") {
      var prev = state.results[req.node] || null;
      touchResult(next, req.node, {
        status: STATUS.RUNNING, jobId: null, progress: null,
        data: prev ? prev.data : null, error: null, at: prev ? prev.at : null,
      });
    } else if (req.kind === "page") {
      var entry = state.results[req.node];
      if (entry) touchResult(next, req.node, assign({}, entry, { paging: true, pageError: null }));
    }
    return next;
  }

  /** The dialog was closed locally (answered, cancelled or expired). */
  function closePrompt(state, promptId) {
    if (!state.prompt || state.prompt.prompt_id !== promptId) return state;
    var next = clone(state);
    next.prompt = state.promptQueue.length ? state.promptQueue[0] : null;
    next.promptQueue = state.promptQueue.slice(1);
    next.promptError = null;
    return next;
  }

  // ---------------------------------------------------------------- selectors

  function topic(state, name) {
    var t = state.topics[name];
    return t ? t.data : null;
  }

  function coreUnavailable(state) {
    var d = topic(state, "device.summary");
    return Boolean(d && d.core === "unavailable");
  }

  /** Running jobs for the Activity popover: own jobs first, then jobs started elsewhere. */
  function activity(state) {
    var out = [];
    var own = {};
    var id;
    for (id in state.jobs) {
      var j = state.jobs[id];
      own[id] = true;
      out.push({ jobId: id, node: j.node, own: true, progress: j.progress || null });
    }
    var device = topic(state, "jobs");
    if (Array.isArray(device)) {
      for (var i = 0; i < device.length; i++) {
        var dj = device[i];
        if (!dj || own[dj.job_id]) continue;
        out.push({ jobId: dj.job_id, node: dj.node, own: false, progress: null });
      }
    }
    return out;
  }

  return {
    STATUS: STATUS,
    RESULT_LRU: RESULT_LRU,
    MAX_ROWS: MAX_ROWS,
    createState: createState,
    applyFrame: applyFrame,
    trackRequest: trackRequest,
    closePrompt: closePrompt,
    dropResult: function (state, nodeId) {
      var next = clone(state);
      dropResult(next, nodeId);
      return next;
    },
    getNode: getNode,
    childrenOf: childrenOf,
    pathTo: pathTo,
    runPolicy: runPolicy,
    isMutating: isMutating,
    resultFor: resultFor,
    liveJobFor: liveJobFor,
    topic: topic,
    coreUnavailable: coreUnavailable,
    activity: activity,
    countRows: countRows,
    appendBlocks: appendBlocks,
    capRows: capRows,
  };
});

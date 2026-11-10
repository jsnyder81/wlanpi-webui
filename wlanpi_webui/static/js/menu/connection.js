/**
 * MenuConnection: one WebSocket to wlanpi-menud through nginx (/ui/ws).
 *
 * Owns the socket lifecycle and the connection state machine from the menu
 * redesign (docs/webui-menu-redesign.md, section 2.9):
 *
 *   idle -> connecting -> handshaking -> live --close--> waiting(n s) -> connecting
 *                                                   \-> terminal (signed-out | refused | reload-needed)
 *
 * No DOM. WebSocket, timers, clock, randomness and the page/window event
 * sources are injected, so the whole machine runs under node --test.
 * The menu page uses two instances: the menu itself and the Front panel pane.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MenuConnection = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BACKOFF_SEC = [1, 2, 4, 8, 15, 30];
  var JITTER = 0.2;
  var BUSY_MIN_SEC = 10;

  var PHASE = {
    IDLE: "idle",
    CONNECTING: "connecting",
    HANDSHAKING: "handshaking",
    LIVE: "live",
    WAITING: "waiting",
    TERMINAL: "terminal",
  };

  var REASON = {
    LOST: "lost",
    RESTARTING: "restarting",
    BUSY: "busy",
    SIGNED_OUT: "signed-out",
    REFUSED: "refused",
    RELOAD_NEEDED: "reload-needed",
  };

  /** What a close code means for the page. */
  function classifyClose(code, hints) {
    hints = hints || {};
    if (code === 4401 || hints.authFailed) return { terminal: true, reason: REASON.SIGNED_OUT };
    if (code === 1008) return { terminal: true, reason: REASON.REFUSED };
    if (code === 4426 || code === 4400) return { terminal: true, reason: REASON.RELOAD_NEEDED };
    if (code === 1013 || typeof hints.retryAfterSec === "number") {
      return { terminal: false, reason: REASON.BUSY };
    }
    if (code === 1001) return { terminal: false, reason: REASON.RESTARTING };
    return { terminal: false, reason: REASON.LOST };
  }

  /** Seconds to wait before reconnect attempt number `attempt` (0-based), before jitter. */
  function backoffBase(attempt) {
    return BACKOFF_SEC[Math.min(Math.max(attempt, 0), BACKOFF_SEC.length - 1)];
  }

  function jittered(baseSec, random) {
    var r = typeof random === "function" ? random() : Math.random();
    return baseSec * (1 - JITTER + 2 * JITTER * r);
  }

  /**
   * @param {object} opts
   *   url            WebSocket URL
   *   hello          object merged into the hello frame (mode, session, client, capabilities),
   *                  or a function returning it
   *   WebSocket      constructor (defaults to the global)
   *   setTimeout / clearTimeout / now / random   injectable for tests
   *   doc            object with `hidden` and add/removeEventListener (visibilitychange)
   *   win            object with add/removeEventListener (online)
   *   checkSignedOut optional () => Promise<boolean>, asked when a socket never opened
   *                  (nginx answers an expired login with 401, which a browser reports as 1006)
   *   onState(state), onFrame(frame)
   */
  function MenuConnection(opts) {
    opts = opts || {};
    this.opts = opts;
    this.url = opts.url;
    this.WS = opts.WebSocket || (typeof WebSocket !== "undefined" ? WebSocket : null);
    this._setTimeout = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    this._clearTimeout = opts.clearTimeout || function (h) { clearTimeout(h); };
    this._now = opts.now || function () { return Date.now(); };
    this._random = opts.random || Math.random;
    this.doc = opts.doc || null;
    this.win = opts.win || null;

    this.ws = null;
    this.seq = 0;
    this.attempt = 0;
    this.timer = null;
    this.deadline = null;
    this.closedByClient = false;
    this.hints = {};
    this.resume = null; // { epoch, session_id, seq: {topic: n}, menu_revision }
    this.state = { phase: PHASE.IDLE, reason: null, retryInSec: null, attempt: 0, paused: false };

    var self = this;
    this._onOnline = function () { self._wake(); };
    this._onVisibility = function () {
      if (self._hidden()) {
        self._pause();
      } else {
        self._wake();
      }
    };
    this._listening = false;
  }

  MenuConnection.prototype._hidden = function () {
    return Boolean(this.doc && this.doc.hidden);
  };

  MenuConnection.prototype._listen = function () {
    if (this._listening) return;
    this._listening = true;
    if (this.win && this.win.addEventListener) this.win.addEventListener("online", this._onOnline);
    if (this.doc && this.doc.addEventListener) this.doc.addEventListener("visibilitychange", this._onVisibility);
  };

  MenuConnection.prototype._unlisten = function () {
    if (!this._listening) return;
    this._listening = false;
    if (this.win && this.win.removeEventListener) this.win.removeEventListener("online", this._onOnline);
    if (this.doc && this.doc.removeEventListener) this.doc.removeEventListener("visibilitychange", this._onVisibility);
  };

  MenuConnection.prototype._setState = function (patch) {
    var next = {};
    var k;
    for (k in this.state) next[k] = this.state[k];
    for (k in patch) next[k] = patch[k];
    this.state = next;
    if (this.opts.onState) this.opts.onState(next);
  };

  MenuConnection.prototype._clearTimer = function () {
    if (this.timer !== null) {
      this._clearTimeout(this.timer);
      this.timer = null;
    }
  };

  /** Open the connection (first load, or after close()). */
  MenuConnection.prototype.start = function () {
    this.closedByClient = false;
    this._listen();
    this._open();
  };

  MenuConnection.prototype._open = function () {
    var self = this;
    this._clearTimer();
    this.deadline = null;
    this.hints = {};
    this.opened = false;
    this._setState({ phase: PHASE.CONNECTING, retryInSec: null, paused: false });

    var ws;
    try {
      ws = new this.WS(this.url);
    } catch (e) {
      this.ws = null;
      this._closed(null, 1006);
      return;
    }
    this.ws = ws;

    ws.onopen = function () {
      if (self.ws !== ws) return;
      self.opened = true;
      self._setState({ phase: PHASE.HANDSHAKING });
      self._sendRaw(self._hello());
    };
    ws.onmessage = function (evt) {
      if (self.ws !== ws) return;
      var frame;
      try {
        frame = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      self._frame(frame);
    };
    ws.onerror = function () {
      /* a close event always follows; the state changes there */
    };
    ws.onclose = function (evt) {
      // A socket this connection has already replaced or dropped must not
      // touch the state of its successor.
      if (self.ws !== ws) return;
      self._closed(ws, evt && typeof evt.code === "number" ? evt.code : 1006);
    };
  };

  MenuConnection.prototype._hello = function () {
    var base = typeof this.opts.hello === "function" ? this.opts.hello() : this.opts.hello || {};
    var frame = { v: 1, type: "hello", id: this.nextId(), protocol: [1] };
    for (var k in base) frame[k] = base[k];
    if (this.resume && this.resume.epoch) {
      var r = { epoch: this.resume.epoch };
      if (this.resume.session_id) r.session_id = this.resume.session_id;
      var seq = {};
      var any = false;
      for (var t in this.resume.seq) {
        seq[t] = this.resume.seq[t];
        any = true;
      }
      if (any) r.seq = seq;
      if (typeof this.resume.menu_revision === "number") r.menu_revision = this.resume.menu_revision;
      frame.resume = r;
    }
    return frame;
  };

  MenuConnection.prototype._frame = function (frame) {
    switch (frame.type) {
      case "welcome":
        this.attempt = 0;
        if (!this.resume || this.resume.epoch !== frame.epoch || this.resume.session_id !== frame.session_id) {
          this.resume = { epoch: frame.epoch, session_id: frame.session_id, seq: {}, menu_revision: undefined };
        } else if (!frame.resumed) {
          this.resume.seq = {};
        }
        this._setState({ phase: PHASE.LIVE, reason: null, retryInSec: null, attempt: 0, paused: false });
        break;
      case "menu":
        if (this.resume) this.resume.menu_revision = frame.revision;
        break;
      case "event":
        if (this.resume && typeof frame.topic === "string" && typeof frame.seq === "number") {
          this.resume.seq[frame.topic] = frame.seq;
        }
        break;
      case "error":
        if (frame.code === "AUTH_FAILED") this.hints.authFailed = true;
        if (typeof frame.retry_after_sec === "number") this.hints.retryAfterSec = frame.retry_after_sec;
        break;
      default:
        break;
    }
    if (this.opts.onFrame) this.opts.onFrame(frame);
  };

  MenuConnection.prototype._closed = function (ws, code) {
    var self = this;
    this.ws = null;
    if (this.closedByClient) {
      this._setState({ phase: PHASE.IDLE, reason: null, retryInSec: null, paused: false });
      return;
    }
    var verdict = classifyClose(code, this.hints);
    if (verdict.terminal) {
      this._terminal(verdict.reason);
      return;
    }
    var retryAfter = this.hints.retryAfterSec;
    var neverOpened = !this.opened;
    this._wait(verdict.reason, retryAfter);
    // nginx turns an expired or revoked login into 401 on the upgrade, which
    // reaches a browser as a plain failed socket. Ask the page.
    if (neverOpened && typeof this.opts.checkSignedOut === "function") {
      var p;
      try {
        p = this.opts.checkSignedOut();
      } catch (e) {
        p = null;
      }
      if (p && typeof p.then === "function") {
        p.then(function (signedOut) {
          if (signedOut && !self.closedByClient && self.state.phase === PHASE.WAITING) {
            self._terminal(REASON.SIGNED_OUT);
          }
        }, function () { /* treat as not signed out */ });
      }
    }
  };

  MenuConnection.prototype._terminal = function (reason) {
    this._clearTimer();
    this.deadline = null;
    this._unlisten();
    this._setState({ phase: PHASE.TERMINAL, reason: reason, retryInSec: null, paused: false });
  };

  MenuConnection.prototype._wait = function (reason, retryAfterSec) {
    var base = backoffBase(this.attempt);
    if (reason === REASON.BUSY) {
      base = Math.max(BUSY_MIN_SEC, typeof retryAfterSec === "number" ? retryAfterSec : 0, base);
    }
    var delayMs = Math.round(jittered(base, this._random) * 1000);
    this.attempt += 1;
    this.deadline = this._now() + delayMs;
    if (this._hidden()) {
      // No timers while the tab is hidden; visibilitychange reconnects.
      this.deadline = null;
      this._setState({ phase: PHASE.WAITING, reason: reason, retryInSec: null, attempt: this.attempt, paused: true });
      return;
    }
    this._setState({
      phase: PHASE.WAITING, reason: reason, retryInSec: Math.ceil(delayMs / 1000), attempt: this.attempt,
      paused: false,
    });
    this._tick();
  };

  MenuConnection.prototype._tick = function () {
    var self = this;
    this._clearTimer();
    if (this.deadline === null) return;
    var left = this.deadline - this._now();
    if (left <= 0) {
      this._open();
      return;
    }
    var secs = Math.ceil(left / 1000);
    if (secs !== this.state.retryInSec) this._setState({ retryInSec: secs });
    // Wake at the next whole-second boundary so the countdown is exact.
    var step = left - (secs - 1) * 1000;
    this.timer = this._setTimeout(function () {
      self.timer = null;
      self._tick();
    }, Math.max(step, 1));
  };

  MenuConnection.prototype._pause = function () {
    if (this.state.phase !== PHASE.WAITING) return;
    this._clearTimer();
    this.deadline = null;
    this._setState({ retryInSec: null, paused: true });
  };

  MenuConnection.prototype._wake = function () {
    if (this.state.phase !== PHASE.WAITING || this.closedByClient) return;
    if (this._hidden()) return;
    this._open();
  };

  /** "Retry now" button. */
  MenuConnection.prototype.retryNow = function () {
    if (this.state.phase !== PHASE.WAITING || this.closedByClient) return;
    this._open();
  };

  MenuConnection.prototype.isLive = function () {
    return this.state.phase === PHASE.LIVE;
  };

  MenuConnection.prototype.nextId = function () {
    this.seq += 1;
    return "c" + this.seq;
  };

  MenuConnection.prototype._sendRaw = function (frame) {
    if (!this.ws) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      return false;
    }
  };

  /**
   * Send a request frame. `fields` holds everything but v and id.
   * Returns the request id, or null when the connection is not live
   * (callers disable their controls instead of raising a toast).
   */
  MenuConnection.prototype.send = function (fields) {
    if (!this.isLive()) return null;
    var frame = { v: 1, id: this.nextId() };
    for (var k in fields) frame[k] = fields[k];
    return this._sendRaw(frame) ? frame.id : null;
  };

  /** Client close (leaving the page, closing the pane). No reconnect follows. */
  MenuConnection.prototype.close = function () {
    this.closedByClient = true;
    this._clearTimer();
    this.deadline = null;
    this._unlisten();
    var ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "client closed");
      } catch (e) {
        /* already closed */
      }
    }
    this._setState({ phase: PHASE.IDLE, reason: null, retryInSec: null, paused: false });
  };

  /** Resume material to carry over a page swap (see main.js). */
  MenuConnection.prototype.getResume = function () {
    return this.resume ? JSON.parse(JSON.stringify(this.resume)) : null;
  };

  MenuConnection.prototype.setResume = function (resume) {
    this.resume = resume ? JSON.parse(JSON.stringify(resume)) : null;
    if (this.resume && !this.resume.seq) this.resume.seq = {};
  };

  MenuConnection.PHASE = PHASE;
  MenuConnection.REASON = REASON;
  MenuConnection.BACKOFF_SEC = BACKOFF_SEC;
  MenuConnection.JITTER = JITTER;
  MenuConnection.classifyClose = classifyClose;
  MenuConnection.backoffBase = backoffBase;

  return MenuConnection;
});

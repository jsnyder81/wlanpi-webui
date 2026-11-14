/**
 * MenuRouter: the current menu location lives in the URL hash.
 *
 *   /menu                      Home
 *   /menu#network              branch page
 *   /menu#network.interfaces   action page
 *   /menu#/tiles               status tiles customize page (client-owned)
 *
 * The hash is the node id exactly as the server sent it; the client builds no
 * paths. A hash that is not in the current menu resolves to "not-available".
 * Hashes starting with "/" are the client's own pages: a node id always
 * starts with a letter, so they never collide with the server's menu.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MenuRouter = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TYPE = {
    LOADING: "loading",
    HOME: "home",
    BRANCH: "branch",
    ACTION: "action",
    NOT_AVAILABLE: "not-available",
    TILES: "tiles",
  };

  /** Client-owned pages, by hash. */
  var TILES_ID = "/tiles";

  /** "#network.interfaces" -> "network.interfaces"; "", "#" -> "" (Home). */
  function parseHash(hash) {
    var raw = typeof hash === "string" ? hash : "";
    if (raw.charAt(0) === "#") raw = raw.slice(1);
    if (!raw) return "";
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
  }

  /** Node id -> href for a link ("#" is Home). */
  function hrefFor(id) {
    if (!id) return "#";
    if (id.charAt(0) === "/") return "#" + id;
    return "#" + encodeURIComponent(id).replace(/%2E/gi, ".");
  }

  /**
   * @param {object} state  MenuStore state
   * @param {string} hash   location.hash
   * @returns {{type: string, id: string, node: object|null}}
   */
  function resolve(state, hash) {
    var id = parseHash(hash);
    if (!state || !state.menu) return { type: TYPE.LOADING, id: id, node: null };
    if (!id) return { type: TYPE.HOME, id: "", node: null };
    if (id === TILES_ID) return { type: TYPE.TILES, id: id, node: null };
    var byId = state.menu.byId;
    var node = Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null;
    if (!node) return { type: TYPE.NOT_AVAILABLE, id: id, node: null };
    return { type: node.kind === "branch" ? TYPE.BRANCH : TYPE.ACTION, id: id, node: node };
  }

  /** Call `cb(hash)` on every hash change. Returns an unsubscribe function. */
  function subscribe(win, cb) {
    function onChange() {
      cb(win.location.hash);
    }
    win.addEventListener("hashchange", onChange);
    return function () {
      win.removeEventListener("hashchange", onChange);
    };
  }

  function navigate(win, id) {
    var href = hrefFor(id);
    if (win.location.hash === href || (!id && !win.location.hash)) return false;
    win.location.hash = href;
    return true;
  }

  return {
    TYPE: TYPE,
    TILES_ID: TILES_ID,
    parseHash: parseHash,
    hrefFor: hrefFor,
    resolve: resolve,
    subscribe: subscribe,
    navigate: navigate,
  };
});

// The Space SDK, served at /s/_sdk/workbench.js. Plain browser JavaScript with
// no dependencies, kept as a string so the server ships it without a build
// step. It defines window.workbench and speaks the wire protocol in
// docs/superpowers/specs/2026-11-07-spaces-design.md:
//
// - The shell posts { __wb: 1, type: "port" } with a MessagePort exactly once,
//   to the frame's contentWindow. The SDK accepts that port only from
//   window.parent and only once; everything after travels over the port.
// - Calls made before the port arrives are queued and flushed in order.
// - Requests are { __wb: 1, id, type, payload }; replies are
//   { __wb: 1, id, ok: true, result } or { __wb: 1, id, ok: false, error }.
// - Each request rejects with TIMEOUT after 120 s.
// - The SDK never sends a `confirmed` field: confirmation is the shell's
//   decision alone.

export const SDK_SOURCE = String.raw`/* workbench Space SDK. See /docs: guides/spaces. */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.workbench) return;

  var TIMEOUT_MS = 120000;

  class WorkbenchError extends Error {
    constructor(code, message, integration, tool) {
      super(message || code);
      this.name = "WorkbenchError";
      this.code = code;
      this.integration = integration;
      this.tool = tool;
    }
  }

  var port = null;
  var queue = [];
  var pending = new Map();
  var nextId = 1;

  function settle(msg) {
    if (!msg || msg.__wb !== 1 || typeof msg.id !== "number") return;
    var entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok === true) {
      entry.resolve(msg.result);
      return;
    }
    var e = msg.error && typeof msg.error === "object" ? msg.error : {};
    entry.reject(
      new WorkbenchError(
        typeof e.code === "string" ? e.code : "UPSTREAM_ERROR",
        typeof e.message === "string" ? e.message : "",
        typeof e.integration === "string" ? e.integration : entry.integration,
        typeof e.tool === "string" ? e.tool : entry.tool
      )
    );
  }

  function send(msg) {
    try {
      port.postMessage(msg);
    } catch (err) {
      var entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.reject(new WorkbenchError("INVALID_ARGS", "Arguments could not be sent: " + (err && err.message), entry.integration, entry.tool));
    }
  }

  function onWindowMessage(event) {
    if (port) return;
    // The handshake comes from the shell, which is our parent. Anything else
    // (the Space itself, another frame, a top-level page) is ignored.
    if (window.parent === window || event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.__wb !== 1 || msg.type !== "port") return;
    var p = event.ports && event.ports[0];
    if (!p) return;
    port = p;
    window.removeEventListener("message", onWindowMessage);
    port.onmessage = function (ev) { settle(ev.data); };
    if (typeof port.start === "function") port.start();
    var queued = queue;
    queue = [];
    for (var i = 0; i < queued.length; i++) {
      if (pending.has(queued[i].id)) send(queued[i]);
    }
  }
  window.addEventListener("message", onWindowMessage);

  function request(type, payload, integration, tool) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var msg = { __wb: 1, id: id, type: type, payload: payload };
      var timer = setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new WorkbenchError("TIMEOUT", "No answer from workbench within 120 s", integration, tool));
      }, TIMEOUT_MS);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer, integration: integration, tool: tool });
      if (port) send(msg);
      else queue.push(msg);
    });
  }

  function invalid(message, integration, tool) {
    return Promise.reject(new WorkbenchError("INVALID_ARGS", message, integration, tool));
  }

  function snapshot(value) {
    // Copy now, so a caller mutating its object after call() changes nothing,
    // and an uncloneable value fails here rather than at the port.
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function call(integration, tool, args) {
    if (typeof integration !== "string" || integration === "") return invalid("integration must be a non-empty string", integration, tool);
    if (typeof tool !== "string" || tool === "") return invalid("tool must be a non-empty string", integration, tool);
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
      return invalid("args must be an object", integration, tool);
    }
    var copy;
    try {
      copy = args === undefined ? {} : snapshot(args);
    } catch (err) {
      return invalid("args could not be copied: " + (err && err.message), integration, tool);
    }
    // Exactly these three fields: never a confirmed flag.
    return request("call", { integration: integration, tool: tool, args: copy }, integration, tool);
  }

  function key(k) {
    return typeof k === "string" && k.length >= 1 && k.length <= 128;
  }

  var store = Object.freeze({
    get: function (k) {
      if (!key(k)) return invalid("key must be 1 to 128 characters");
      return request("kv.get", { key: k });
    },
    set: function (k, value) {
      if (!key(k)) return invalid("key must be 1 to 128 characters");
      var copy;
      try {
        copy = snapshot(value);
      } catch (err) {
        return invalid("value could not be copied: " + (err && err.message));
      }
      return request("kv.set", { key: k, value: copy }).then(function () { return undefined; });
    },
    delete: function (k) {
      if (!key(k)) return invalid("key must be 1 to 128 characters");
      return request("kv.delete", { key: k }).then(function () { return undefined; });
    },
    keys: function () {
      return request("kv.keys", {});
    },
  });

  var workbench = Object.freeze({
    call: call,
    me: function () { return request("me", {}); },
    store: store,
    WorkbenchError: WorkbenchError,
  });

  Object.defineProperty(window, "workbench", { value: workbench, writable: false, configurable: false, enumerable: true });
  Object.defineProperty(window, "WorkbenchError", { value: WorkbenchError, writable: false, configurable: false, enumerable: false });
})();
`;

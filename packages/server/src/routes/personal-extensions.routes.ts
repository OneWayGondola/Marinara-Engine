import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  approvePersonalExtensionSchema,
  createPersonalExtensionSchema,
  externalExtensionsPolicyUpdateSchema,
  personalExtensionStoragePatchSchema,
  rollbackPersonalExtensionSchema,
  updatePersonalExtensionSchema,
  type PersonalClientExtensionRuntime,
  type PersonalExtension,
} from "@marinara-engine/shared";
import { requirePrivilegedAccess } from "../middleware/privileged-gate.js";
import { createPersonalExtensionsStorage } from "../services/extensions/personal-extension-storage.service.js";
import { createPersonalExtensionSettingsStorage } from "../services/extensions/personal-extension-settings.service.js";
import { createAppSettingsStorage } from "../services/storage/app-settings.storage.js";
import { personalServerExtensionRuntime } from "../services/extensions/personal-server-extension-runtime.js";
import {
  canExecutePersonalExtension,
  getPersonalExtensionPolicy,
  isExternalPersonalExtensionSource,
  setExternalExtensionsEnabled,
} from "../services/extensions/personal-extension-policy.service.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function privileged(req: Parameters<typeof requirePrivilegedAccess>[0], reply: Parameters<typeof requirePrivilegedAccess>[1]) {
  return requirePrivilegedAccess(req, reply, { feature: "Personal Extensions" });
}

function escapeClosingTag(source: string, tag: "style") {
  return source.replace(new RegExp(`</${tag}`, "giu"), `<\\/${tag}`);
}

export function browserWorkerSource(extension: PersonalExtension) {
  const identity = JSON.stringify({
    id: extension.id,
    name: extension.name,
    contentHash: extension.contentHash,
  });
  return `
(() => {
  "use strict";
  const extension = ${identity};
  const send = self.postMessage.bind(self);
  const cleanupFns = [];
  let requestId = 0;
  const pending = new Map();
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "Worker", "SharedWorker", "WebTransport", "importScripts"]) {
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  const storage = (action, payload) => new Promise((resolve, reject) => {
    const id = String(++requestId);
    pending.set(id, { resolve, reject });
    send({ type: "storage", requestId: id, action, payload });
  });
  const managedTimeout = (fn, ms) => {
    const timer = self.setTimeout(fn, Math.max(0, Math.min(2147483647, Number(ms) || 0)));
    cleanupFns.push(() => self.clearTimeout(timer));
    return timer;
  };
  const managedInterval = (fn, ms) => {
    const timer = self.setInterval(fn, Math.max(1, Math.min(2147483647, Number(ms) || 1)));
    cleanupFns.push(() => self.clearInterval(timer));
    return timer;
  };
  const log = (level, args) => send({ type: "log", level, args: args.map((value) => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  }) });
  // Constrained UI: the worker describes a window as a small whitelist of
  // element descriptors. The trusted iframe bootstrap renders them with
  // textContent only (never HTML) and routes button clicks back here, so the
  // extension gets interactive UI without any DOM, markup, or host access.
  const MAX_UI_WINDOWS = 4;
  const MAX_UI_ELEMENTS = 60;
  const MAX_UI_TEXT = 8000;
  const UI_ELEMENT_KINDS = new Set(["heading", "text", "pre", "button", "input", "spacer"]);
  const uiWindows = new Set();
  const uiEventHandlers = new Map();
  const uiCloseHandlers = new Map();
  let uiWindowCounter = 0;
  const clampText = (value) => String(value == null ? "" : value).slice(0, MAX_UI_TEXT);
  const normalizeUiElements = (elements) => {
    if (!Array.isArray(elements)) throw new Error("window elements must be an array");
    if (elements.length > MAX_UI_ELEMENTS) throw new Error("window has too many elements (max " + MAX_UI_ELEMENTS + ")");
    return elements.map((element) => {
      if (!element || typeof element !== "object" || !UI_ELEMENT_KINDS.has(element.kind)) {
        throw new Error("unsupported window element");
      }
      if (element.kind === "button" || element.kind === "input") {
        if (typeof element.id !== "string" || !element.id) throw new Error(element.kind + " element requires a string id");
      }
      return {
        kind: element.kind,
        id: typeof element.id === "string" ? element.id.slice(0, 128) : undefined,
        text: clampText(element.text),
        label: element.label == null ? undefined : clampText(element.label),
        placeholder: element.placeholder == null ? undefined : clampText(element.placeholder),
        value: element.value == null ? undefined : clampText(element.value),
        multiline: element.kind === "input" ? Boolean(element.multiline) : undefined,
      };
    });
  };
  const showWindow = (options) => {
    const config = options || {};
    if (uiWindows.size >= MAX_UI_WINDOWS) throw new Error("too many open extension windows (max " + MAX_UI_WINDOWS + ")");
    const windowId = "w" + String(++uiWindowCounter);
    const elements = normalizeUiElements(config.elements);
    uiWindows.add(windowId);
    if (typeof config.onEvent === "function") uiEventHandlers.set(windowId, config.onEvent);
    if (typeof config.onClose === "function") uiCloseHandlers.set(windowId, config.onClose);
    send({ type: "ui-show", windowId, title: clampText(config.title || extension.name), elements });
    return {
      id: windowId,
      update: (next) => {
        if (!uiWindows.has(windowId)) return;
        const patch = next || {};
        send({
          type: "ui-update",
          windowId,
          title: patch.title == null ? undefined : clampText(patch.title),
          elements: patch.elements == null ? undefined : normalizeUiElements(patch.elements),
        });
      },
      close: () => {
        if (!uiWindows.delete(windowId)) return;
        uiEventHandlers.delete(windowId);
        uiCloseHandlers.delete(windowId);
        send({ type: "ui-close", windowId });
      },
    };
  };
  const marinara = Object.freeze({
    runtime: "client",
    version: 3,
    extensionId: extension.id,
    extensionName: extension.name,
    log: Object.freeze({
      debug: (...args) => log("debug", args),
      info: (...args) => log("info", args),
      warn: (...args) => log("warn", args),
      error: (...args) => log("error", args),
    }),
    storage: Object.freeze({
      get: () => storage("get"),
      patch: (patch) => storage("patch", patch),
      delete: () => storage("delete"),
    }),
    ui: Object.freeze({
      showWindow,
    }),
    setTimeout: managedTimeout,
    setInterval: managedInterval,
    clearTimeout: self.clearTimeout.bind(self),
    clearInterval: self.clearInterval.bind(self),
    onCleanup: (fn) => {
      if (typeof fn !== "function") throw new Error("onCleanup requires a function");
      cleanupFns.push(fn);
    },
  });
  self.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "storage-result") {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error(message.error || "Extension storage request failed"));
    }
    if (message?.type === "ui-event" && typeof message.windowId === "string") {
      const handler = uiEventHandlers.get(message.windowId);
      if (handler) {
        try {
          handler({
            windowId: message.windowId,
            elementId: typeof message.elementId === "string" ? message.elementId : "",
            values: message.values && typeof message.values === "object" ? message.values : {},
          });
        } catch (error) {
          send({ type: "log", level: "error", args: [error instanceof Error ? error.message : String(error)] });
        }
      }
    }
    if (message?.type === "ui-closed" && typeof message.windowId === "string") {
      if (uiWindows.delete(message.windowId)) {
        const handler = uiCloseHandlers.get(message.windowId);
        uiEventHandlers.delete(message.windowId);
        uiCloseHandlers.delete(message.windowId);
        if (handler) { try { handler({ windowId: message.windowId }); } catch {} }
      }
    }
    if (message?.type === "stop") {
      for (const cleanup of [...cleanupFns].reverse()) {
        try { cleanup(); } catch {}
      }
      cleanupFns.length = 0;
      send({ type: "stopped" });
      self.close();
    }
  });
  self.setInterval(() => send({ type: "heartbeat" }), 1_000);
  Promise.resolve((async () => {
    "use strict";
${extension.js ?? ""}
  })()).then(
    () => send({ type: "ready", contentHash: extension.contentHash }),
    (error) => send({ type: "error", contentHash: extension.contentHash, message: error instanceof Error ? error.message : String(error) }),
  );
})();
`;
}

export function sandboxDocument(extension: PersonalExtension, nonce: string) {
  const boot = JSON.stringify({
    id: extension.id,
    name: extension.name,
    contentHash: extension.contentHash,
    workerSource: browserWorkerSource(extension),
  }).replace(/</gu, "\\u003c");
  const css = escapeClosingTag(extension.css ?? "", "style");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<style>${css}</style>
</head>
<body>
<script nonce="${nonce}">
(() => {
  "use strict";
  const extension = ${boot};
  const post = (message) => window.parent.postMessage({ channel: "marinara-personal-extension", ...message }, "*");
  const workerUrl = URL.createObjectURL(new Blob([extension.workerSource], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  URL.revokeObjectURL(workerUrl);

  // Host-rendered window layer. The worker only sends element descriptors;
  // everything below builds DOM with textContent (never parsed markup) inside
  // this opaque-origin iframe, so the extension can present interactive UI
  // without touching Marinara's page or being able to inject markup. The iframe
  // is sized by the host to just this floating panel — it does not cover or
  // take over Marinara's page.
  const theme = { accent: "#a855f7", accentText: "#ffffff", surface: "rgba(24,24,27,0.98)", text: "#f4f4f5", border: "rgba(127,127,127,0.35)", muted: "rgba(127,127,127,0.15)" };
  const root = document.createElement("div");
  root.setAttribute("data-ext-root", "");
  Object.assign(root.style, { display: "none", fontFamily: "system-ui, sans-serif", boxSizing: "border-box" });
  document.documentElement.style.background = "transparent";
  document.body.style.margin = "0";
  document.body.style.background = "transparent";
  document.body.appendChild(root);
  const uiWindows = new Map();
  const applyThemeVars = () => {
    root.style.setProperty("--ext-accent", theme.accent);
    root.style.setProperty("--ext-accent-text", theme.accentText);
    root.style.setProperty("--ext-surface", theme.surface);
    root.style.setProperty("--ext-text", theme.text);
    root.style.setProperty("--ext-border", theme.border);
    root.style.setProperty("--ext-muted", theme.muted);
  };
  applyThemeVars();
  const reportSize = () => {
    if (uiWindows.size === 0) return;
    const width = Math.min(420, Math.max(240, Math.ceil(root.scrollWidth)));
    const height = Math.max(80, Math.ceil(root.scrollHeight));
    post({ type: "ui-resize", contentHash: extension.contentHash, width, height });
  };
  const syncVisibility = (justOpened) => {
    const open = uiWindows.size > 0;
    root.style.display = open ? "block" : "none";
    if (!open) { post({ type: "ui-window-close", contentHash: extension.contentHash }); return; }
    if (justOpened) post({ type: "ui-window-open", contentHash: extension.contentHash });
    reportSize();
  };
  const closeWindowLocally = (windowId, notifyWorker) => {
    const entry = uiWindows.get(windowId);
    if (!entry) return;
    entry.card.remove();
    uiWindows.delete(windowId);
    if (notifyWorker) worker.postMessage({ type: "ui-closed", windowId });
    syncVisibility(false);
  };
  const collectValues = (windowId) => {
    const values = {};
    const entry = uiWindows.get(windowId);
    if (entry) for (const [id, node] of entry.inputs) values[id] = String(node.value ?? "");
    return values;
  };
  const buildElement = (windowId, descriptor, inputs) => {
    if (descriptor.kind === "heading") {
      const el = document.createElement("h2");
      el.textContent = descriptor.text || "";
      Object.assign(el.style, { margin: "0 0 0.25rem", fontSize: "1rem", fontWeight: "700" });
      return el;
    }
    if (descriptor.kind === "text") {
      const el = document.createElement("p");
      el.textContent = descriptor.text || "";
      Object.assign(el.style, { margin: "0", lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word" });
      return el;
    }
    if (descriptor.kind === "pre") {
      const el = document.createElement("pre");
      el.textContent = descriptor.text || "";
      Object.assign(el.style, { margin: "0", padding: "0.5rem", borderRadius: "6px", background: "var(--ext-muted)", overflow: "auto", fontFamily: "ui-monospace, monospace", fontSize: "0.8125rem", lineHeight: "1.4" });
      return el;
    }
    if (descriptor.kind === "spacer") {
      const el = document.createElement("div");
      el.style.height = "0.25rem";
      return el;
    }
    if (descriptor.kind === "input") {
      const wrap = document.createElement("label");
      Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.8125rem" });
      if (descriptor.label) { const lab = document.createElement("span"); lab.textContent = descriptor.label; wrap.appendChild(lab); }
      const field = descriptor.multiline ? document.createElement("textarea") : document.createElement("input");
      if (!descriptor.multiline) field.type = "text";
      if (descriptor.placeholder) field.placeholder = descriptor.placeholder;
      field.value = descriptor.value || "";
      field.setAttribute("data-ext-input", descriptor.id);
      Object.assign(field.style, { padding: "0.4rem 0.5rem", borderRadius: "6px", border: "1px solid var(--ext-border)", background: "var(--ext-muted)", color: "inherit", font: "inherit" });
      if (descriptor.multiline) field.rows = 4;
      inputs.set(descriptor.id, field);
      wrap.appendChild(field);
      return wrap;
    }
    if (descriptor.kind === "button") {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = descriptor.label || descriptor.text || "Button";
      Object.assign(el.style, { alignSelf: "flex-start", padding: "0.4rem 0.85rem", borderRadius: "6px", border: "1px solid var(--ext-accent)", background: "var(--ext-accent)", color: "var(--ext-accent-text)", font: "inherit", fontWeight: "600", cursor: "pointer" });
      el.addEventListener("click", () => {
        worker.postMessage({ type: "ui-event", windowId, elementId: descriptor.id, values: collectValues(windowId) });
      });
      return el;
    }
    return document.createElement("span");
  };
  const renderBody = (entry, elements) => {
    entry.body.textContent = "";
    entry.inputs = new Map();
    for (const descriptor of elements) entry.body.appendChild(buildElement(entry.id, descriptor, entry.inputs));
  };
  const showWindow = (windowId, title, elements) => {
    closeWindowLocally(windowId, false);
    const card = document.createElement("section");
    Object.assign(card.style, { display: "block", width: "100%", boxSizing: "border-box", border: "1px solid var(--ext-border)", background: "var(--ext-surface)", color: "var(--ext-text)", overflow: "hidden" });
    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", padding: "0.5rem 0.5rem 0.5rem 0.85rem", borderBottom: "1px solid var(--ext-border)" });
    const titleEl = document.createElement("strong");
    titleEl.textContent = title || extension.name;
    titleEl.style.fontSize = "0.875rem";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, { border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "1rem", lineHeight: "1", padding: "0.35rem 0.5rem", borderRadius: "6px" });
    closeBtn.addEventListener("click", () => closeWindowLocally(windowId, true));
    header.appendChild(titleEl);
    header.appendChild(closeBtn);
    const body = document.createElement("div");
    Object.assign(body.style, { display: "flex", flexDirection: "column", gap: "0.6rem", padding: "0.85rem" });
    card.appendChild(header);
    card.appendChild(body);
    root.appendChild(card);
    const entry = { id: windowId, card, body, titleEl, inputs: new Map() };
    uiWindows.set(windowId, entry);
    renderBody(entry, elements);
    syncVisibility(true);
  };
  const updateWindow = (windowId, title, elements) => {
    const entry = uiWindows.get(windowId);
    if (!entry) return;
    if (typeof title === "string") entry.titleEl.textContent = title;
    if (Array.isArray(elements)) renderBody(entry, elements);
    reportSize();
  };

  let lastHeartbeat = Date.now();
  let stopped = false;
  let messageWindowStartedAt = Date.now();
  let messageCount = 0;
  worker.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "heartbeat") {
      lastHeartbeat = Date.now();
      return;
    }
    if (Date.now() - messageWindowStartedAt > 10_000) {
      messageWindowStartedAt = Date.now();
      messageCount = 0;
    }
    messageCount += 1;
    if (messageCount > 200) {
      stopped = true;
      worker.terminate();
      window.clearInterval(watchdog);
      post({ type: "error", contentHash: extension.contentHash, message: "Browser extension was stopped for exceeding the sandbox message limit" });
      return;
    }
    if (message?.type === "storage") {
      let payloadSize = 0;
      try { payloadSize = new TextEncoder().encode(JSON.stringify(message.payload ?? null)).byteLength; } catch { payloadSize = 1_000_001; }
      if (!["get", "patch", "delete"].includes(message.action) || payloadSize > 1_000_000) {
        worker.postMessage({
          type: "storage-result",
          requestId: message.requestId,
          ok: false,
          error: "Storage request was rejected by the sandbox",
        });
        return;
      }
    }
    if (message?.type === "ui-show") {
      showWindow(message.windowId, message.title, Array.isArray(message.elements) ? message.elements : []);
      return;
    }
    if (message?.type === "ui-update") {
      updateWindow(message.windowId, message.title, message.elements);
      return;
    }
    if (message?.type === "ui-close") {
      closeWindowLocally(message.windowId, false);
      return;
    }
    if (message?.type === "storage" || message?.type === "log" || message?.type === "ready" || message?.type === "error") {
      post(message);
    }
  });
  worker.addEventListener("error", (event) => {
    post({ type: "error", contentHash: extension.contentHash, message: event.message || "Browser extension worker failed" });
  });
  const watchdog = window.setInterval(() => {
    if (stopped || Date.now() - lastHeartbeat <= 5_000) return;
    stopped = true;
    worker.terminate();
    window.clearInterval(watchdog);
    post({ type: "error", contentHash: extension.contentHash, message: "Browser extension was stopped because its sandbox became unresponsive" });
  }, 1_000);
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.channel !== "marinara-personal-extension") return;
    const message = event.data;
    if (message.type === "storage-result") worker.postMessage(message);
    if (message.type === "ui-theme" && message.theme && typeof message.theme === "object") {
      // The host forwards Marinara's resolved accent/surface colors so the
      // in-iframe window matches the app; values are only ever used as CSS.
      for (const key of ["accent", "accentText", "surface", "text", "border", "muted"]) {
        if (typeof message.theme[key] === "string" && message.theme[key]) theme[key] = message.theme[key];
      }
      applyThemeVars();
    }
    if (message.type === "ui-dismiss") {
      for (const windowId of [...uiWindows.keys()]) closeWindowLocally(windowId, true);
    }
    if (message.type === "stop") {
      stopped = true;
      window.clearInterval(watchdog);
      for (const windowId of [...uiWindows.keys()]) closeWindowLocally(windowId, false);
      worker.postMessage({ type: "stop" });
      window.setTimeout(() => worker.terminate(), 500);
    }
  });
})();
</script>
</body>
</html>`;
}

export async function personalExtensionsRoutes(app: FastifyInstance) {
  const storage = createPersonalExtensionsStorage(app.db);
  const settings = createPersonalExtensionSettingsStorage(createAppSettingsStorage(app.db));

  app.get("/policy", async () => getPersonalExtensionPolicy(app.db));

  app.patch("/policy/external", async (req, reply) => {
    if (!privileged(req, reply)) return;
    const input = externalExtensionsPolicyUpdateSchema.parse(req.body);
    if (input.enabled && !(await getPersonalExtensionPolicy(app.db)).externalExtensionsEnvEnabled) {
      return reply.status(409).send({
        error: "External Extensions are locked. Set ENABLE_EXTERNAL_EXTENSIONS=true in .env first.",
      });
    }
    const policy = await setExternalExtensionsEnabled(app.db, input.enabled);
    if (!policy.externalExtensionsEnabled) await storage.disableExternal();
    await personalServerExtensionRuntime.enforceExternalPolicy();
    return policy;
  });

  app.get("/", async (req, reply) => {
    if (!privileged(req, reply)) return;
    const policy = await getPersonalExtensionPolicy(app.db);
    return (await storage.list())
      .filter((extension) => canExecutePersonalExtension(extension, policy))
      .map((extension) => personalServerExtensionRuntime.withRuntimeStatus(extension));
  });

  app.get("/runtime/client", async (): Promise<PersonalClientExtensionRuntime[]> => {
    const policy = await getPersonalExtensionPolicy(app.db);
    const extensions = await storage.list();
    return extensions
      .filter(
        (extension) =>
          extension.runtime === "client" &&
          extension.enabled &&
          extension.approvedHash === extension.contentHash &&
          canExecutePersonalExtension(extension, policy),
      )
      .map((extension) => ({
        id: extension.id,
        name: extension.name,
        description: extension.description,
        contentHash: extension.contentHash,
        sandboxUrl: `/api/personal-extensions/${encodeURIComponent(extension.id)}/sandbox.html?hash=${encodeURIComponent(extension.contentHash)}`,
      }));
  });

  app.get<{ Params: { id: string }; Querystring: { hash?: string } }>("/:id/sandbox.html", async (req, reply) => {
    if (!ID_PATTERN.test(req.params.id)) return reply.status(404).send("Not Found");
    const policy = await getPersonalExtensionPolicy(app.db);
    const extension = await storage.getById(req.params.id);
    if (
      !extension ||
      extension.runtime !== "client" ||
      !extension.enabled ||
      extension.approvedHash !== extension.contentHash ||
      req.query.hash !== extension.contentHash ||
      !canExecutePersonalExtension(extension, policy)
    ) {
      return reply.status(404).send("Not Found");
    }
    const nonce = randomBytes(18).toString("base64");
    reply.type("text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; worker-src blob:; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    );
    return sandboxDocument(extension, nonce);
  });

  app.post("/", async (req, reply) => {
    if (!privileged(req, reply)) return;
    const policy = await getPersonalExtensionPolicy(app.db);
    if (!policy.externalExtensionsEnabled) {
      return reply.status(403).send({
        error: "External Extension imports require both ENABLE_EXTERNAL_EXTENSIONS=true and the Danger Zone opt-in.",
      });
    }
    const input = createPersonalExtensionSchema.parse(req.body);
    const existing = await storage.getByName(input.name);
    if (existing) {
      return reply.status(409).send({ error: `A Personal Extension named "${input.name}" already exists`, id: existing.id });
    }
    return storage.create(input, { source: "external" });
  });

  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    if (!privileged(req, reply)) return;
    if (!ID_PATTERN.test(req.params.id)) return reply.status(404).send({ error: "Personal Extension not found" });
    const input = updatePersonalExtensionSchema.parse(req.body);
    const existing = await storage.getById(req.params.id);
    if (!existing) return reply.status(404).send({ error: "Personal Extension not found" });
    const updated = input.enabled === false ? await storage.disable(req.params.id) : await storage.update(req.params.id, input);
    if (existing.runtime === "server" || updated?.runtime === "server") {
      await personalServerExtensionRuntime.reloadExtension(req.params.id);
    }
    return updated;
  });

  app.post<{ Params: { id: string } }>("/:id/approve", async (req, reply) => {
    if (!privileged(req, reply)) return;
    if (!ID_PATTERN.test(req.params.id)) return reply.status(404).send({ error: "Personal Extension not found" });
    const input = approvePersonalExtensionSchema.parse(req.body);
    const existing = await storage.getById(req.params.id);
    if (!existing) return reply.status(404).send({ error: "Personal Extension not found" });
    const policy = await getPersonalExtensionPolicy(app.db);
    if (isExternalPersonalExtensionSource(existing.source) && !policy.externalExtensionsEnabled) {
      return reply.status(403).send({ error: "External Extensions are locked by the two-step safety gate." });
    }
    if (existing.runtime === "server" && !policy.serverSandboxAvailable) {
      return reply.status(503).send({ error: policy.serverSandboxReason ?? "No supported server sandbox is available." });
    }
    const approved = await storage.approve(req.params.id, input.contentHash);
    if (!approved) return reply.status(404).send({ error: "Personal Extension not found" });
    if (approved.runtime === "server") await personalServerExtensionRuntime.reloadExtension(approved.id);
    return personalServerExtensionRuntime.withRuntimeStatus(approved);
  });

  app.post<{ Params: { id: string } }>("/:id/rollback", async (req, reply) => {
    if (!privileged(req, reply)) return;
    if (!ID_PATTERN.test(req.params.id)) return reply.status(404).send({ error: "Personal Extension not found" });
    const input = rollbackPersonalExtensionSchema.parse(req.body);
    const existing = await storage.getById(req.params.id);
    if (!existing) return reply.status(404).send({ error: "Personal Extension not found" });
    const rolledBack = await storage.rollback(req.params.id, input.contentHash);
    if (existing.runtime === "server" || rolledBack?.runtime === "server") {
      await personalServerExtensionRuntime.reloadExtension(req.params.id);
    }
    return rolledBack;
  });

  const browserStorageExtension = async (id: string) => {
    const extension = ID_PATTERN.test(id) ? await storage.getById(id) : null;
    if (
      !extension ||
      extension.runtime !== "client" ||
      !extension.enabled ||
      extension.approvedHash !== extension.contentHash ||
      !canExecutePersonalExtension(extension, await getPersonalExtensionPolicy(app.db))
    ) {
      return null;
    }
    return extension;
  };

  app.get<{ Params: { id: string } }>("/:id/storage", async (req, reply) => {
    const extension = await browserStorageExtension(req.params.id);
    if (!extension) return reply.status(404).send({ error: "Personal Extension not found" });
    return { value: await settings.get(extension.id) };
  });

  app.patch<{ Params: { id: string } }>("/:id/storage", async (req, reply) => {
    const extension = await browserStorageExtension(req.params.id);
    if (!extension) return reply.status(404).send({ error: "Personal Extension not found" });
    const patch = personalExtensionStoragePatchSchema.parse(req.body ?? {});
    return { value: await settings.patch(extension.id, patch) };
  });

  app.delete<{ Params: { id: string } }>("/:id/storage", async (req, reply) => {
    const extension = await browserStorageExtension(req.params.id);
    if (!extension) return reply.status(404).send({ error: "Personal Extension not found" });
    await settings.remove(extension.id);
    return { value: {} };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    if (!privileged(req, reply)) return;
    if (!ID_PATTERN.test(req.params.id)) return reply.status(404).send({ error: "Personal Extension not found" });
    const existing = await storage.getById(req.params.id);
    if (!existing) return reply.status(404).send({ error: "Personal Extension not found" });
    await settings.remove(existing.id);
    await storage.remove(existing.id);
    if (existing.runtime === "server") await personalServerExtensionRuntime.unloadExtension(existing.id);
    return reply.status(204).send();
  });
}

import { useEffect } from "react";
import { CSRF_HEADER, CSRF_HEADER_VALUE, type PersonalClientExtensionRuntime } from "@marinara-engine/shared";
import { usePersonalExtensionRuntime } from "../../hooks/use-personal-extensions";

type ActiveClientExtension = {
  contentHash: string;
  extension: PersonalClientExtensionRuntime;
  iframe: HTMLIFrameElement;
};

type SandboxMessage = {
  channel?: string;
  type?: "ready" | "error" | "log" | "storage" | "ui-window-open" | "ui-window-close" | "ui-resize";
  contentHash?: string;
  requestId?: string;
  action?: "get" | "patch" | "delete";
  payload?: unknown;
  level?: "debug" | "info" | "warn" | "error";
  args?: unknown[];
  message?: string;
  width?: number;
  height?: number;
};

// The sandbox iframe is a hidden 0×0 element until the extension opens a
// window; then it becomes a small floating panel docked bottom-right. It never
// covers Marinara's page — the rest of the app stays visible and interactive.
function setSandboxIframeHidden(iframe: HTMLIFrameElement) {
  iframe.hidden = true;
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.removeAttribute("style");
}

function sizeSandboxPanel(iframe: HTMLIFrameElement, width?: number, height?: number) {
  const maxW = Math.max(240, Math.min(window.innerWidth - 32, 420));
  const maxH = Math.round(window.innerHeight * 0.7);
  const w = Math.max(240, Math.min(typeof width === "number" ? width : 340, maxW));
  const h = Math.max(80, Math.min(typeof height === "number" ? height : 240, maxH));
  iframe.hidden = false;
  iframe.removeAttribute("aria-hidden");
  iframe.tabIndex = 0;
  Object.assign(iframe.style, {
    position: "fixed",
    right: "1rem",
    bottom: "1rem",
    top: "auto",
    left: "auto",
    width: `${w}px`,
    height: `${h}px`,
    maxWidth: "calc(100vw - 2rem)",
    maxHeight: "80vh",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
    background: "transparent",
    overflow: "hidden",
    zIndex: "2147483000",
    colorScheme: "normal",
  });
}

// Forward Marinara's resolved accent/surface colors so the in-iframe window
// matches the current theme. Only color strings cross the boundary.
function postSandboxTheme(iframe: HTMLIFrameElement) {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  iframe.contentWindow?.postMessage(
    {
      channel: "marinara-personal-extension",
      type: "ui-theme",
      theme: {
        accent: read("--primary", "#a855f7"),
        accentText: read("--primary-foreground", "#ffffff"),
        surface: read("--card", "#18181b"),
        text: read("--foreground", "#f4f4f5"),
        border: read("--border", "rgba(127,127,127,0.35)"),
        muted: read("--secondary", "rgba(127,127,127,0.15)"),
      },
    },
    "*",
  );
}

const activeExtensions = new Map<string, ActiveClientExtension>();

function extensionFetch(id: string, path: string, init: RequestInit = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  return fetch(`/api/personal-extensions/${encodeURIComponent(id)}/${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}

async function cleanupExtension(id: string) {
  const active = activeExtensions.get(id);
  activeExtensions.delete(id);
  if (!active) return;
  active.iframe.contentWindow?.postMessage({ channel: "marinara-personal-extension", type: "stop" }, "*");
  active.iframe.remove();
}

const STORAGE_ACTIONS = new Set<SandboxMessage["action"]>(["get", "patch", "delete"]);
const LOG_LEVELS = new Set<NonNullable<SandboxMessage["level"]>>(["debug", "info", "warn", "error"]);

async function handleStorage(active: ActiveClientExtension, message: SandboxMessage) {
  // Never infer DELETE from an unknown action: a malformed message must be
  // rejected, not silently mapped onto a destructive request.
  if (!message.requestId || !STORAGE_ACTIONS.has(message.action)) {
    active.iframe.contentWindow?.postMessage(
      {
        channel: "marinara-personal-extension",
        type: "storage-result",
        requestId: message.requestId,
        ok: false,
        error: "Storage request was rejected by the host",
      },
      "*",
    );
    return;
  }
  try {
    let value: Record<string, unknown> = {};
    if (message.action === "get") {
      const response = await extensionFetch(active.extension.id, "storage");
      if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
      value = ((await response.json()) as { value?: Record<string, unknown> }).value ?? {};
    } else if (message.action === "patch") {
      const response = await extensionFetch(active.extension.id, "storage", {
        method: "PATCH",
        body: JSON.stringify(message.payload ?? {}),
      });
      if (!response.ok) throw new Error(`Storage update failed (${response.status})`);
      value = ((await response.json()) as { value?: Record<string, unknown> }).value ?? {};
    } else {
      const response = await extensionFetch(active.extension.id, "storage", { method: "DELETE" });
      if (!response.ok) throw new Error(`Storage delete failed (${response.status})`);
    }
    active.iframe.contentWindow?.postMessage(
      {
        channel: "marinara-personal-extension",
        type: "storage-result",
        requestId: message.requestId,
        ok: true,
        value,
      },
      "*",
    );
  } catch (error) {
    active.iframe.contentWindow?.postMessage(
      {
        channel: "marinara-personal-extension",
        type: "storage-result",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      "*",
    );
  }
}

export function PersonalExtensionInjector() {
  const { data: extensions = [] } = usePersonalExtensionRuntime();

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const active = [...activeExtensions.values()].find((candidate) => candidate.iframe.contentWindow === event.source);
      if (!active || event.origin !== "null") return;
      const message = event.data as SandboxMessage;
      if (!message || message.channel !== "marinara-personal-extension") return;
      if (message.type === "storage") {
        void handleStorage(active, message);
        return;
      }
      if (message.type === "ui-window-open") {
        sizeSandboxPanel(active.iframe, message.width, message.height);
        postSandboxTheme(active.iframe);
        return;
      }
      if (message.type === "ui-resize") {
        if (!active.iframe.hidden) sizeSandboxPanel(active.iframe, message.width, message.height);
        return;
      }
      if (message.type === "ui-window-close") {
        setSandboxIframeHidden(active.iframe);
        return;
      }
      if (message.type === "log" && LOG_LEVELS.has(message.level as NonNullable<SandboxMessage["level"]>)) {
        const args = Array.isArray(message.args) ? message.args : [];
        console[message.level as NonNullable<SandboxMessage["level"]>](
          `[Personal Extension ${active.extension.name}]`,
          ...args,
        );
        return;
      }
      if (message.type === "ready" && message.contentHash === active.contentHash) {
        window.dispatchEvent(
          new CustomEvent("marinara-personal-extension-ready", {
            detail: { id: active.extension.id, contentHash: active.contentHash },
          }),
        );
        return;
      }
      if (message.type === "error") {
        console.error(`[Personal Extension ${active.extension.name}] failed`, message.message);
        window.dispatchEvent(
          new CustomEvent("marinara-personal-extension-error", {
            detail: {
              id: active.extension.id,
              contentHash: active.contentHash,
              message: message.message ?? "Sandboxed browser extension failed",
            },
          }),
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const expected = new Map(extensions.map((extension) => [extension.id, extension]));
    for (const [id, active] of activeExtensions) {
      const next = expected.get(id);
      if (!next || next.contentHash !== active.contentHash) void cleanupExtension(id);
    }

    for (const extension of extensions) {
      const active = activeExtensions.get(extension.id);
      if (active?.contentHash === extension.contentHash) continue;
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      iframe.hidden = true;
      iframe.src = extension.sandboxUrl;
      iframe.dataset.personalExtensionSandbox = extension.id;
      iframe.referrerPolicy = "no-referrer";
      document.body.appendChild(iframe);
      activeExtensions.set(extension.id, {
        contentHash: extension.contentHash,
        extension,
        iframe,
      });
    }
  }, [extensions]);

  useEffect(
    () => () => {
      for (const id of [...activeExtensions.keys()]) void cleanupExtension(id);
    },
    [],
  );

  return null;
}

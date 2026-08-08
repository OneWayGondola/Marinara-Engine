export type PersonalExtensionTrafficSnapshot = {
  requests: number;
  bytes: number;
  requestsLastMinute: number;
  sustainedHighRate: boolean;
};

type PersonalExtensionTrafficRecord = {
  requests: number;
  bytes: number;
  requestTimes: number[];
};

const trafficByExtension = new Map<string, PersonalExtensionTrafficRecord>();
const listeners = new Set<() => void>();
const RATE_WINDOW_MS = 60_000;
const SUSTAINED_WINDOW_COUNT = 3;
const HIGH_RATE_REQUESTS_PER_MINUTE = 60;

function emitTrafficChange() {
  for (const listener of listeners) listener();
}

function requestBodyBytes(body: BodyInit | null | undefined) {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

function addTransferredBytes(extensionId: string, bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const current = trafficByExtension.get(extensionId);
  if (!current) return;
  current.bytes += bytes;
  emitTrafficChange();
}

export function recordPersonalExtensionRequest(extensionId: string, bytes = 0, now = Date.now()) {
  const current = trafficByExtension.get(extensionId) ?? { requests: 0, bytes: 0, requestTimes: [] };
  current.requests += 1;
  current.bytes += Math.max(0, bytes);
  current.requestTimes.push(now);
  const oldestTrackedRequest = now - RATE_WINDOW_MS * SUSTAINED_WINDOW_COUNT;
  current.requestTimes = current.requestTimes.filter((requestedAt) => requestedAt >= oldestTrackedRequest);
  trafficByExtension.set(extensionId, current);
  emitTrafficChange();
}

export function getPersonalExtensionTraffic(extensionId: string, now = Date.now()): PersonalExtensionTrafficSnapshot {
  const current = trafficByExtension.get(extensionId);
  if (!current) return { requests: 0, bytes: 0, requestsLastMinute: 0, sustainedHighRate: false };

  const requestsPerWindow = Array.from({ length: SUSTAINED_WINDOW_COUNT }, () => 0);
  for (const requestedAt of current.requestTimes) {
    const age = now - requestedAt;
    if (age < 0 || age >= RATE_WINDOW_MS * SUSTAINED_WINDOW_COUNT) continue;
    requestsPerWindow[Math.floor(age / RATE_WINDOW_MS)] += 1;
  }

  return {
    requests: current.requests,
    bytes: current.bytes,
    requestsLastMinute: requestsPerWindow[0],
    sustainedHighRate: requestsPerWindow.every((requests) => requests > HIGH_RATE_REQUESTS_PER_MINUTE),
  };
}

export function subscribePersonalExtensionTraffic(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function fetchForPersonalExtension(extensionId: string, input: RequestInfo | URL, init?: RequestInit) {
  recordPersonalExtensionRequest(extensionId, requestBodyBytes(init?.body));
  const response = await window.fetch(input, init);
  const responseBytes = Number(response.headers.get("content-length"));
  addTransferredBytes(extensionId, responseBytes);
  return response;
}

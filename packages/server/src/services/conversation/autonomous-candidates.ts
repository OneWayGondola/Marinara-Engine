/**
 * Background-autonomous candidate filter (#4704): conversation chats with
 * autonomous messaging enabled, excluding the Professor Mari home assistant.
 * Mirrors the client-side legacy filter in use-background-autonomous.ts (kept
 * there as the old-server fallback) — the two must stay in sync. Kept as a
 * pure predicate so the /chats/autonomous-candidates route and the regression
 * suite share one definition. Unparseable or missing metadata disqualifies.
 */
/**
 * Roleplay DM threads are garbage-collected when emptied (see
 * cleanupEmptyRoleplayDmChats in chats.routes.ts). The candidates route must
 * exclude EMPTY chats carrying these markers: the legacy poll path ran the
 * cleanup as a GET /chats side effect, and without that an emptied DM thread
 * with stale in-memory activity state could receive an autonomous message —
 * permanently exempting it from cleanup. Same marker expression as the
 * cleanup; keep the two in sync.
 */
export function hasRoleplayDmThreadMarkers(metadata: Record<string, unknown>): boolean {
  return metadata.roleplayDmThread === true || typeof metadata.dmOriginChatId === "string";
}

export function isBackgroundAutonomousCandidate(chat: { mode?: string | null; metadata?: unknown }): boolean {
  if (chat.mode !== "conversation") return false;
  const raw = chat.metadata;
  if (!raw) return false;
  let meta: Record<string, unknown>;
  try {
    meta = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
  } catch {
    return false;
  }
  if (!meta || typeof meta !== "object") return false;
  if (meta.internalAssistant === "professor-mari") return false;
  return !!meta.autonomousMessages;
}

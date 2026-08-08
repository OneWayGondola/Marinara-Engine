import type { PendingSpatialTransition, ResolvedSpatialTravel } from "@marinara-engine/shared";

export interface RecoveredSpatialOwnerTurnResponse {
  applied: true;
  messageId: string;
  currentLocationId: string | null;
  definitionRevision: number;
  travel?: ResolvedSpatialTravel;
}

export function shouldKeepPendingSpatialTransition(travel?: ResolvedSpatialTravel): boolean {
  return travel?.mode === "step_by_step" && travel.complete === false;
}

export function spatialOwnerTurnRecoveryPath(chatId: string, transition: PendingSpatialTransition): string {
  const query = new URLSearchParams({
    destinationId: transition.destinationId,
    expectedDefinitionRevision: String(transition.expectedDefinitionRevision),
  });
  if (transition.expectedCurrentLocationId !== null) {
    query.set("expectedCurrentLocationId", transition.expectedCurrentLocationId);
  }
  if (transition.travelMode) query.set("travelMode", transition.travelMode);
  return `/chats/${encodeURIComponent(chatId)}/spatial-context/turn/${encodeURIComponent(transition.commandId)}?${query.toString()}`;
}

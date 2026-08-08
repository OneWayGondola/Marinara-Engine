import type { PendingSpatialTransition } from "@marinara-engine/shared";

interface CyoaChoiceImpersonationOptions {
  presetId?: string | null;
  connectionId?: string | null;
  blockAgents?: boolean;
  promptTemplate?: string;
}

export function buildCyoaChoiceSubmissionPayload(input: {
  chatId: string;
  text: string;
  pendingSpatialTransition?: PendingSpatialTransition | null;
  impersonation?: CyoaChoiceImpersonationOptions;
}) {
  const promptTemplate = input.impersonation?.promptTemplate?.trim();
  return {
    chatId: input.chatId,
    connectionId: null,
    userMessage: input.text,
    ...(input.pendingSpatialTransition ? { pendingSpatialTransition: input.pendingSpatialTransition } : {}),
    ...(input.impersonation
      ? {
          impersonate: true as const,
          ...(input.impersonation.presetId ? { impersonatePresetId: input.impersonation.presetId } : {}),
          ...(input.impersonation.connectionId ? { impersonateConnectionId: input.impersonation.connectionId } : {}),
          ...(input.impersonation.blockAgents ? { impersonateBlockAgents: true as const } : {}),
          ...(promptTemplate ? { impersonatePromptTemplate: promptTemplate } : {}),
        }
      : {}),
  };
}

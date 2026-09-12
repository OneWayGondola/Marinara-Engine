import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import { useChatStore } from "../stores/chat.store";
import { useConnection } from "./use-connections";
import { usePresetFull } from "./use-presets";

export type EffectiveGenerationParameters = Record<string, { value: unknown; source: string; enabled: boolean }>;

export function useEffectiveGenerationParameters(connectionId: string | null, enabled = true) {
  const chat = useChatStore((state) => state.activeChat);
  const { data: connection } = useConnection(connectionId);
  const presetId = (chat?.mode === "roleplay" ? connection?.promptPresetId : null) || chat?.promptPresetId || null;
  const { data: preset } = usePresetFull(typeof presetId === "string" ? presetId : null);
  return useQuery({
    queryKey: [
      "effective-generation-parameters",
      connectionId,
      presetId,
      chat?.id,
      chat?.metadata,
      chat?.mode,
      connection?.updatedAt,
      preset?.preset.updatedAt,
    ],
    enabled: enabled && !!connectionId && connectionId !== "random" && connectionId !== "__local_sidecar__",
    queryFn: () =>
      api.post<{
        chatName: string | null;
        inheritedParameters: Record<string, unknown>;
        parameters: EffectiveGenerationParameters;
      }>("/generate/parameters", {
        connectionId,
        ...(chat?.id ? { chatId: chat.id } : {}),
      }),
    staleTime: 0,
  });
}

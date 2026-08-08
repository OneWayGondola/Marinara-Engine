import type { Message } from "@marinara-engine/shared";

export type ProfessorMariContextBudget = {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

export function resolveProfessorMariContextBudget(
  messages: readonly Message[],
  maxContext: number | null | undefined,
): ProfessorMariContextBudget | null {
  const maxTokens = tokenCount(maxContext);
  if (!maxTokens || maxTokens <= 0) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const generationInfo = record(message.extra?.generationInfo);
    if (!generationInfo) continue;
    const legacyUsage = record(generationInfo.usage);
    const promptTokens = tokenCount(generationInfo.tokensPrompt) ?? tokenCount(legacyUsage?.promptTokens);
    const completionTokens =
      tokenCount(generationInfo.tokensCompletion) ?? tokenCount(legacyUsage?.completionTokens) ?? 0;
    if (promptTokens === null) continue;

    const usedTokens = promptTokens + completionTokens;
    return {
      usedTokens,
      maxTokens,
      percentage: Math.min(100, (usedTokens / maxTokens) * 100),
    };
  }

  return null;
}

export function formatCompactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 100 || Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 100 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return String(value);
}

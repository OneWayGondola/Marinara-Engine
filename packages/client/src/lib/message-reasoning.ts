export interface MessageReasoningDisplay {
  summary: string | null;
  summaryUnavailable: boolean;
  hasReasoning: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Resolve the user-visible reasoning state from persisted message metadata.
 * A positive reasoning-token count proves that reasoning ran even when the
 * provider omitted the separately requested displayable summary.
 */
export function resolveMessageReasoningDisplay(extra: unknown): MessageReasoningDisplay {
  const extraRecord = asRecord(extra);
  const rawThinking = extraRecord?.thinking;
  const summary = typeof rawThinking === "string" && rawThinking.trim().length > 0 ? rawThinking : null;
  const generationInfo = asRecord(extraRecord?.generationInfo);
  const reasoningTokens = generationInfo?.tokensReasoning;
  const summaryUnavailable =
    summary === null && typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens > 0;

  return {
    summary,
    summaryUnavailable,
    hasReasoning: summary !== null || summaryUnavailable,
  };
}

import type { CapabilityEmbeddingHost } from "@marinara-engine/shared";
import { createHash } from "node:crypto";
import type { DB } from "../../db/connection.js";
import { localEmbed } from "../local-embedder.js";
import { logger } from "../../lib/logger.js";
import { resolveMemoryRecallEmbeddingSource } from "../memory-recall-embedding.js";

const MAX_EMBEDDING_TEXTS = 128;
const MAX_EMBEDDING_CHARACTERS = 200_000;
const LTM_EMBEDDING_SPACE_ID = "local:Xenova/all-MiniLM-L6-v2:q8:mean:normalized:v1";
const LTM_EMBEDDING_LABEL = "Built-in local MiniLM";

export function createCapabilityEmbeddingHost(): CapabilityEmbeddingHost {
  return Object.freeze({
    spaceId: LTM_EMBEDDING_SPACE_ID,
    label: LTM_EMBEDDING_LABEL,
    async embed(texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
      if (texts.length === 0 || texts.length > MAX_EMBEDDING_TEXTS) return null;
      if (texts.reduce((total, text) => total + text.length, 0) > MAX_EMBEDDING_CHARACTERS) return null;
      return localEmbed(texts, signal);
    },
  });
}

export async function createConfiguredCapabilityEmbeddingHost(
  db: DB,
  connectionId?: string | null,
): Promise<CapabilityEmbeddingHost> {
  try {
    const source = await resolveMemoryRecallEmbeddingSource(db, { connectionId });
    if (!source) return createCapabilityEmbeddingHost();
    const fallbackSpaceId = `remote:${createHash("sha256").update(source.label).digest("hex")}`;
    return Object.freeze({
      spaceId: source.spaceId ?? fallbackSpaceId,
      label: source.label,
      async embed(texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
        if (texts.length === 0 || texts.length > MAX_EMBEDDING_TEXTS) return null;
        if (texts.reduce((total, text) => total + text.length, 0) > MAX_EMBEDDING_CHARACTERS) return null;
        return source.embed(texts, signal);
      },
    });
  } catch (error) {
    logger.warn(error, "Could not resolve configured capability embeddings; using the built-in local embedder");
    return createCapabilityEmbeddingHost();
  }
}

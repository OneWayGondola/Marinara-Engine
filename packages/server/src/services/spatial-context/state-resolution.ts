import type { ResolvedSpatialTravel, SpatialContextDefinition, SpatialContextSnapshot } from "@marinara-engine/shared";
import { getCapabilityService } from "../capability-packages/capability-service-registry.service.js";
import { isHierarchicalMapsEnabledForChat } from "./activation.js";

export type AssistantSpatialDirective =
  | { type: "move"; destinationId: string }
  | {
      type: "discover";
      name: string;
      relation: "enter" | "link";
      direction?: "outgoing" | "incoming" | "both";
      description?: string;
    };

export interface ParsedAssistantSpatialDirective {
  cleanContent: string;
  directive: AssistantSpatialDirective | null;
  matched: boolean;
}

const ASSISTANT_SPATIAL_COMMAND_RE = /\[spatial_(move|discover):\s*([^\]\r\n]*)\]/giu;
const ASSISTANT_SPATIAL_COMMAND_PREFIXES = ["[spatial_move:", "[spatial_discover:"] as const;
const ASSISTANT_SPATIAL_COMMAND_PREFIX_ONLY_RE = /^\[spatial_(?:move|discover):\s*$/iu;

export interface AssistantSpatialDirectiveStreamFilter {
  push(content: string): string;
  flush(): string;
}

/** Hide package-owned commands while they stream, before final response cleanup can replace the visible text. */
export function createAssistantSpatialDirectiveStreamFilter(): AssistantSpatialDirectiveStreamFilter {
  let candidate = "";
  let commandOpen = false;

  return {
    push(content) {
      let visible = "";
      for (const character of content) {
        if (!candidate) {
          if (character === "[") candidate = character;
          else visible += character;
          continue;
        }

        candidate += character;
        if (commandOpen) {
          if (character === "]") {
            candidate = "";
            commandOpen = false;
          } else if (
            candidate.length > 8_192 ||
            ((character === "\n" || character === "\r") && !ASSISTANT_SPATIAL_COMMAND_PREFIX_ONLY_RE.test(candidate))
          ) {
            visible += candidate;
            candidate = "";
            commandOpen = false;
          }
          continue;
        }

        const normalized = candidate.toLowerCase();
        if (ASSISTANT_SPATIAL_COMMAND_PREFIXES.some((prefix) => prefix === normalized)) {
          commandOpen = true;
          continue;
        }
        if (ASSISTANT_SPATIAL_COMMAND_PREFIXES.some((prefix) => prefix.startsWith(normalized))) continue;

        visible += candidate;
        candidate = "";
      }
      return visible;
    },
    flush() {
      const remaining = candidate;
      candidate = "";
      commandOpen = false;
      return remaining;
    },
  };
}

function parseCommandAttributes(body: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of body.matchAll(/(\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s\]]+)/gu)) {
    const key = match[1]?.trim().toLowerCase();
    const rawValue = match[2]?.trim();
    if (!key || !rawValue) continue;
    values.set(key, rawValue.replace(/^['"]|['"]$/gu, ""));
  }
  return values;
}

/** Extract the last valid package-owned location command and hide all such commands from chat text. */
export function extractAssistantSpatialDirective(content: string): ParsedAssistantSpatialDirective {
  let directive: AssistantSpatialDirective | null = null;
  let matched = false;
  for (const match of content.matchAll(ASSISTANT_SPATIAL_COMMAND_RE)) {
    matched = true;
    const command = match[1]?.toLowerCase();
    const values = parseCommandAttributes(match[2] ?? "");
    if (command === "move") {
      const destinationId = (values.get("destination_id") ?? values.get("destination") ?? "").trim().slice(0, 128);
      if (destinationId) directive = { type: "move", destinationId };
      continue;
    }
    if (command === "discover") {
      const name = (values.get("name") ?? "").trim().slice(0, 200);
      if (!name) continue;
      const relation = values.get("relation")?.trim().toLowerCase() === "link" ? "link" : "enter";
      const directionValue = values.get("direction")?.trim().toLowerCase();
      const direction =
        directionValue === "outgoing" || directionValue === "incoming" || directionValue === "both"
          ? directionValue
          : undefined;
      if (relation === "link" && !direction) continue;
      const description = (values.get("description") ?? "").trim().slice(0, 4_000);
      directive = {
        type: "discover",
        name,
        relation,
        ...(direction ? { direction } : {}),
        ...(description ? { description } : {}),
      };
    }
  }
  if (!matched) {
    return { cleanContent: content, directive: null, matched: false };
  }
  return {
    cleanContent: content
      .replace(ASSISTANT_SPATIAL_COMMAND_RE, "")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
    directive,
    matched: true,
  };
}

export interface SpatialMessageAnchor {
  messageId: string;
  swipeIndex: number;
}

export interface EffectiveSpatialState {
  definition: SpatialContextDefinition | null;
  snapshot: SpatialContextSnapshot | null;
  currentLocationId: string | null;
  definitionRevision: number;
  visibleAnchor: SpatialMessageAnchor | null;
  virtual: boolean;
}

export interface ResolveSpatialStateOptions {
  exactAnchor?: SpatialMessageAnchor;
  throughMessageId?: string;
  beforeMessageId?: string;
  /** Accepted owner-turn travel facts to include in the next prompt projection. */
  acceptedTravel?: ResolvedSpatialTravel | null;
}

interface StateResolutionService {
  parseStoredSpatialDefinition(rawMetadata: unknown): SpatialContextDefinition | null;
  resolveEffectiveSpatialState(chatId: string, options?: ResolveSpatialStateOptions): Promise<EffectiveSpatialState>;
  materializeAssistantSpatialState(input: {
    chatId: string;
    messageId: string;
    swipeIndex: number;
    regenerate: boolean;
    continuation: boolean;
    directive?: AssistantSpatialDirective | null;
    locationGuidance?: string | null;
  }): Promise<SpatialContextSnapshot | null>;
}

const service = () => getCapabilityService<StateResolutionService>("hierarchical-maps:state-resolution");

export function parseStoredSpatialDefinition(rawMetadata: unknown): SpatialContextDefinition | null {
  return service()?.parseStoredSpatialDefinition(rawMetadata) ?? null;
}

export async function resolveEffectiveSpatialState(
  chatId: string,
  options: ResolveSpatialStateOptions,
  chatMetadata: unknown,
): Promise<EffectiveSpatialState> {
  if (!isHierarchicalMapsEnabledForChat(chatMetadata)) {
    return {
      definition: null,
      snapshot: null,
      currentLocationId: null,
      definitionRevision: 0,
      visibleAnchor: null,
      virtual: false,
    };
  }
  return (
    service()?.resolveEffectiveSpatialState(chatId, options) ?? {
      definition: null,
      snapshot: null,
      currentLocationId: null,
      definitionRevision: 0,
      visibleAnchor: null,
      virtual: false,
    }
  );
}

export async function materializeAssistantSpatialState(
  input: {
    chatId: string;
    messageId: string;
    swipeIndex: number;
    regenerate: boolean;
    continuation: boolean;
    directive?: AssistantSpatialDirective | null;
    locationGuidance?: string | null;
  },
  chatMetadata: unknown,
): Promise<SpatialContextSnapshot | null> {
  if (!isHierarchicalMapsEnabledForChat(chatMetadata)) return null;
  return service()?.materializeAssistantSpatialState(input) ?? null;
}

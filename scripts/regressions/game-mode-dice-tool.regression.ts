import assert from "node:assert/strict";
import type { AgentContext } from "@marinara-engine/shared";
import type { LLMToolDefinition } from "../../packages/server/src/services/llm/base-provider.js";
import {
  GAME_MODE_AUTO_ATTACH_TOOL_NAMES,
  resolveChatToolDefs,
  resolveGenerationTools,
  type ResolveGenerationToolsArgs,
} from "../../packages/server/src/services/generation/tool-resolution-runtime.js";
import {
  executeToolCalls,
  PERSISTED_GAME_STATE_UPDATE_TYPES,
} from "../../packages/server/src/services/tools/tool-executor.js";
import { parseRollDiceToolResult } from "../../packages/server/src/services/game/dice.service.js";
import { buildGmFormatReminder } from "../../packages/server/src/services/game/gm-prompts.js";
import { updateGameStateToolManifest } from "../../packages/shared/src/features/function-calls/tools/update-game-state/manifest.js";

// Game Mode rolls real dice by attaching roll_dice to every game turn through a channel that
// is deliberately NOT the chat's "Enable Tool Use" toggle — flipping that would also arm the
// rest of the default tool set, the Spotify credential lookup, and the local-endpoint
// <available_functions> injection. These checks pin the four things that make that honest:
// which tools a turn resolves, the roll's message-extra shape, the narrowed
// update_game_state enum, and the GM prompt line without which the tool is never called.

// ── 1. Auto-attach resolution ──────────────────────────────────────────────

function toolDef(name: string): LLMToolDefinition {
  return { type: "function", function: { name, description: name, parameters: {} } };
}

const allToolDefs = [
  toolDef("roll_dice"),
  toolDef("update_game_state"),
  toolDef("search_lorebook"),
  toolDef("web_search"),
  toolDef("update_about_me"),
  toolDef("save_lorebook_entry"),
];
const names = (defs: LLMToolDefinition[] | undefined) => defs?.map((def) => def.function.name);

assert.deepEqual(
  names(
    resolveChatToolDefs({
      allToolDefs,
      enableChatTools: false,
      activeToolIds: [],
      autoAttachToolNames: GAME_MODE_AUTO_ATTACH_TOOL_NAMES,
    }),
  ),
  ["roll_dice"],
  "a game turn with tool use switched off must attach the dice tool and nothing else",
);

assert.equal(
  resolveChatToolDefs({
    allToolDefs,
    enableChatTools: false,
    activeToolIds: [],
    autoAttachToolNames: [],
  }),
  undefined,
  "a turn with nothing auto-attached and the toggle off must resolve no tools at all",
);

assert.deepEqual(
  names(
    resolveChatToolDefs({
      allToolDefs,
      enableChatTools: true,
      activeToolIds: [],
      autoAttachToolNames: [],
    }),
  ),
  ["roll_dice", "update_game_state", "search_lorebook", "web_search"],
  "with the toggle on and nothing auto-attached, the default-on set must be unchanged",
);

assert.deepEqual(
  names(
    resolveChatToolDefs({
      allToolDefs,
      enableChatTools: true,
      activeToolIds: [],
      autoAttachToolNames: GAME_MODE_AUTO_ATTACH_TOOL_NAMES,
    }),
  ),
  ["roll_dice", "update_game_state", "search_lorebook", "web_search"],
  "auto-attach must union into the default-on set without duplicating the dice tool",
);

assert.deepEqual(
  names(
    resolveChatToolDefs({
      allToolDefs,
      enableChatTools: true,
      activeToolIds: ["web_search"],
      autoAttachToolNames: GAME_MODE_AUTO_ATTACH_TOOL_NAMES,
    }),
  ),
  ["roll_dice", "web_search"],
  "a per-chat tool filter that leaves the dice tool out must still get it on a game turn",
);

assert.equal(
  resolveChatToolDefs({
    allToolDefs,
    enableChatTools: false,
    activeToolIds: [],
    autoAttachToolNames: ["save_lorebook_entry"],
  }),
  undefined,
  "an agent-only name must not open a tool channel: nothing is attachable, so the turn is unchanged",
);

assert.deepEqual(
  names(
    resolveChatToolDefs({
      allToolDefs,
      enableChatTools: true,
      activeToolIds: ["web_search"],
      autoAttachToolNames: ["save_lorebook_entry"],
    }),
  ),
  ["web_search"],
  "auto-attach must never smuggle an agent-only tool onto a chat turn",
);

// ── 2. The same resolution through the real entry point ────────────────────

function baseArgs(overrides: Partial<ResolveGenerationToolsArgs>): ResolveGenerationToolsArgs {
  return {
    requestBody: {},
    chatId: "chat-dice",
    chatMetadata: {},
    chats: {} as ResolveGenerationToolsArgs["chats"],
    agentsStore: {},
    customToolsStore: { listEnabled: async () => [] } as unknown as ResolveGenerationToolsArgs["customToolsStore"],
    lorebooksStore: {} as unknown as ResolveGenerationToolsArgs["lorebooksStore"],
    resolvedAgents: [],
    enabledConfigs: [],
    promptCharacterIds: [],
    personaId: null,
    activeLorebookIds: [],
    excludedLorebookIds: [],
    excludedSourceAgentIds: [],
    gameState: null,
    gameSpotifyMusicEnabled: false,
    agentContext: {
      chatMode: "game",
      characters: [],
      recentMessages: [],
      memory: {},
    } as unknown as AgentContext,
    emitMetadataPatch: () => {},
    ...overrides,
  };
}

const gameTurn = await resolveGenerationTools(
  baseArgs({ autoAttachToolNames: GAME_MODE_AUTO_ATTACH_TOOL_NAMES }),
);
assert.equal(gameTurn.enableChatTools, false, "auto-attach must not turn the chat's tool toggle on");
assert.equal(gameTurn.toolsAttached, true, "a game turn must take the tool-calling branch");
assert.deepEqual(names(gameTurn.toolDefs), ["roll_dice"], "a game turn must send exactly the dice tool");
assert.deepEqual(
  [...gameTurn.chatResolvedToolNames],
  ["roll_dice"],
  "the execution allowlist must be the auto-attached tool, so nothing else can be called",
);

const conversationTurn = await resolveGenerationTools(
  baseArgs({
    agentContext: {
      chatMode: "conversation",
      characters: [],
      recentMessages: [],
      memory: {},
    } as unknown as AgentContext,
  }),
);
assert.equal(conversationTurn.toolsAttached, false, "a turn with no auto-attach must be left exactly as it was");
assert.equal(conversationTurn.toolDefs, undefined, "a turn with no auto-attach must send no tools");

const gameTurnWithToolsOn = await resolveGenerationTools(
  baseArgs({
    chatMetadata: { enableTools: true },
    autoAttachToolNames: GAME_MODE_AUTO_ATTACH_TOOL_NAMES,
  }),
);
assert.equal(gameTurnWithToolsOn.enableChatTools, true);
assert.equal(gameTurnWithToolsOn.toolsAttached, true);
assert.ok(
  gameTurnWithToolsOn.chatResolvedToolNames.has("roll_dice"),
  "turning tool use on must keep the dice tool rather than replace the auto-attached set",
);
assert.ok(
  gameTurnWithToolsOn.chatResolvedToolNames.size > 1,
  "turning tool use on must still resolve the rest of the default-on tools",
);

// ── 3. The message-extra shape a rolled die is saved as ────────────────────

const [rolled] = await executeToolCalls([
  { id: "call-1", type: "function", function: { name: "roll_dice", arguments: JSON.stringify({ notation: "2d6+3" }) } },
]);
assert.equal(rolled?.success, true, "roll_dice must succeed on valid notation");
const card = parseRollDiceToolResult(rolled!.result);
assert.ok(card, "a successful roll must read back as a dice card payload");
assert.deepEqual(
  Object.keys(card!).sort(),
  ["modifier", "notation", "rolls", "total"],
  "the saved extra must be exactly the DiceRollResult shape /roll writes — no extra fields for the card to trip on",
);
assert.equal(card!.notation, "2d6+3");
assert.equal(card!.modifier, 3);
assert.equal(card!.rolls.length, 2);
assert.equal(
  card!.total,
  card!.rolls.reduce((sum, roll) => sum + roll, 0) + 3,
  "the card must show the number the model was given, not a re-roll",
);

const [refused] = await executeToolCalls([
  { id: "call-2", type: "function", function: { name: "roll_dice", arguments: JSON.stringify({ notation: "d20" }) } },
]);
assert.equal(refused?.success, false, "the tool still rejects notation it cannot parse");
assert.equal(parseRollDiceToolResult(refused!.result), null, "a refusal must never render as a dice card");
assert.equal(parseRollDiceToolResult("not json"), null);
assert.equal(parseRollDiceToolResult(JSON.stringify({ notation: "1d20", rolls: [], modifier: 0, total: 4 })), null);

// ── 4. update_game_state narrowed to the two types that persist ────────────
// The other four were answered with `applied: true` and then dropped on the floor.
// Whether these two should persist at all is issue #5898's question, not this one's.

assert.deepEqual(
  (updateGameStateToolManifest.parameters.properties.type as { enum: string[] }).enum,
  ["location_change", "time_advance"],
  "the model must only be offered the update types the route actually writes back",
);
assert.deepEqual(
  (updateGameStateToolManifest.parameters.properties.type as { enum: string[] }).enum,
  [...PERSISTED_GAME_STATE_UPDATE_TYPES],
  "the schema the model is offered and the guard the executor applies must not drift apart",
);

for (const deadType of ["stat_change", "inventory_add", "inventory_remove", "quest_update"]) {
  const [result] = await executeToolCalls([
    {
      id: `call-${deadType}`,
      type: "function",
      function: {
        name: "update_game_state",
        arguments: JSON.stringify({ type: deadType, target: "player", key: "hp", value: "-3" }),
      },
    },
  ]);
  assert.equal(result?.success, false, `${deadType} must be refused rather than reported as applied`);
  const payload = JSON.parse(result!.result) as Record<string, unknown>;
  assert.equal(payload.applied, undefined, `${deadType} must not claim it was applied`);
  assert.equal(typeof payload.error, "string", `${deadType} must come back with a readable refusal`);
  assert.ok(
    String(payload.error).includes("update_game_state"),
    `${deadType}'s refusal must name the tool so the GM knows what failed`,
  );
  assert.ok(
    String(payload.error).includes("location_change") && String(payload.error).includes("time_advance"),
    `${deadType}'s refusal must name what is allowed instead, or the GM can only guess`,
  );
}

const [locationChange] = await executeToolCalls([
  {
    id: "call-location",
    type: "function",
    function: {
      name: "update_game_state",
      arguments: JSON.stringify({ type: "location_change", target: "player", key: "location", value: "Riverwatch" }),
    },
  },
]);
assert.equal(locationChange?.success, true, "location_change still persists and must still be accepted");
assert.equal(
  (JSON.parse(locationChange!.result) as Record<string, unknown>).applied,
  true,
  "an update type that is written back may still report that it applied",
);

// ── 5. The GM prompt line, without which the tool is attached and never used ──

const reminder = buildGmFormatReminder({ hasSceneModel: false, turnNumber: 1 } as Parameters<
  typeof buildGmFormatReminder
>[0]);
assert.match(reminder, /roll_dice/, "every game turn's format reminder must teach the GM to call the dice tool");
assert.match(reminder, /Never invent a die result/i, "the prompt must forbid inventing the number");
assert.match(
  reminder,
  /\[skill_check: \.\.\.\] tag above/,
  "the prompt must keep the check tag as the record rather than replace it with the tool",
);

const playerRolledReminder = buildGmFormatReminder({
  hasSceneModel: false,
  turnNumber: 1,
  playerDiceRollSubmitted: true,
} as Parameters<typeof buildGmFormatReminder>[0]);
assert.match(
  playerRolledReminder,
  /Use their roll rather than calling the tool again/,
  "a turn the player already rolled for must not ask the GM to re-roll it",
);

console.info("Game Mode dice-tool regression passed.");

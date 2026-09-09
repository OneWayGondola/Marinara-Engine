import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameState } from "../../packages/shared/src/types/game-state.js";
const dir = mkdtempSync(join(tmpdir(), "marinara-tool-outcomes-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
const { executeToolCalls } = await import("../../packages/server/src/services/tools/tool-executor.js");
const { worldTrackerLockKey } = await import("../../packages/shared/dist/index.js");
const { OpenAIProvider } = await import("../../packages/server/src/services/llm/providers/openai.provider.js");
const db = await getDB();
const chats = createChatsStorage(db);
const states = createGameStateStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(generateRoutes, { prefix: "/api/generate" });
const call = (type = "location_change", value = "Harbor") => ({
  id: "change",
  type: "function" as const,
  function: { name: "update_game_state", arguments: JSON.stringify({ type, value }) },
});
const original = OpenAIProvider.prototype.chatComplete;
let expectedSuccess = true;
OpenAIProvider.prototype.chatComplete = async (messages) => {
  const result = messages.findLast((message) => message.role === "tool");
  if (!result) return { content: null, toolCalls: [call()], finishReason: "tool_calls" };
  const receipt = JSON.parse(result.content);
  assert.equal(receipt.applied === true, expectedSuccess);
  if (!expectedSuccess) assert.match(receipt.error, /locked/);
  return {
    content: expectedSuccess ? "The party reaches the harbor." : "The location stays unchanged.",
    toolCalls: [],
    finishReason: "stop",
  };
};
try {
  const connection = await createConnectionsStorage(db).create({
    name: "Fixture",
    provider: "openai",
    model: "fixture",
    apiKey: "synthetic",
  });
  const chat = (await chats.create({
    name: "Receipts",
    mode: "game",
    characterIds: [],
    connectionId: connection.id,
    promptPresetId: null,
  }))!;
  await chats.patchMetadata(chat.id, { enableAgents: false, enableTools: true, activeToolIds: ["update_game_state"] });
  await states.create({
    chatId: chat.id,
    messageId: "",
    swipeIndex: 0,
    date: "Day 1",
    time: "10:00",
    location: "Square",
    weather: "Clear",
    temperature: "Mild",
    worldCustomFields: [],
    presentCharacters: [],
    recentEvents: [],
    playerStats: null,
    personaStats: null,
    fieldLocks: null,
    committed: true,
  } as Omit<GameState, "id" | "createdAt">);
  const context = {
    applyGameStateUpdate: ({ type, value }: { type: string; value: string }) =>
      states.updateFromTool(chat.id, type === "location_change" ? "location" : "time", value, false),
  };
  const [unavailable] = await executeToolCalls([call()]);
  assert.equal(unavailable?.success, false, "no persistence host means no applied receipt");
  assert.doesNotMatch(unavailable!.result, /"applied":true/);
  const [unsupported] = await executeToolCalls([call("inventory_add", "Sword")], context);
  assert.equal(unsupported?.success, false);
  const [empty] = await executeToolCalls([call("time_advance", "  ")], context);
  assert.equal(empty?.success, false);
  const [changed] = await executeToolCalls([call("time_advance", "18:00")], context);
  assert.equal(changed?.success, true);
  assert.equal((await states.getLatest(chat.id))?.time, "18:00");
  await assert.rejects(() => states.updateFromTool(chat.id, "location", "Forest", true), /Spatial Context/);
  assert.equal((await states.getLatest(chat.id))?.location, "Square");
  await assert.rejects(() => states.updateFromTool("missing-chat", "time", "12:00", false), /No game-state snapshot/);
  const [failedWrite] = await executeToolCalls([call()], {
    applyGameStateUpdate: async () => {
      throw new Error("Storage failed");
    },
  });
  assert.equal(failedWrite?.success, false);
  assert.match(failedWrite!.result, /Storage failed/);
  const [falseReceipt] = await executeToolCalls([call()], {
    applyGameStateUpdate: async () => ({ location: "Elsewhere" }),
  });
  assert.equal(falseReceipt?.success, false);
  for (const locked of [false, true]) {
    expectedSuccess = !locked;
    await states.updateLatest(chat.id, {
      location: "Square",
      fieldLocks: locked ? { [worldTrackerLockKey("location")]: true } : null,
    });
    await chats.createMessage({ chatId: chat.id, role: "user", content: "Go to the harbor." });
    const response = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: chat.id, streaming: true },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes('"type":"error"'), response.body);
    assert.match(response.body, new RegExp('"success":' + String(!locked)));
    assert.equal((await states.getLatest(chat.id))?.location, locked ? "Square" : "Harbor");
    if (locked) assert.doesNotMatch(response.body, /"type":"game_state_patch"/);
    else
      assert.ok(
        response.body.indexOf('"type":"game_state_patch"') < response.body.indexOf('"type":"tool_result"'),
        "the state is stored before success is reported",
      );
  }
} finally {
  OpenAIProvider.prototype.chatComplete = original;
  await app.close();
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  "Game-state tools report only stored updates and refuse unavailable, locked, or Spatial Context-owned writes.",
);

import assert from "node:assert/strict";
import { executeAgent, executeAgentBatch } from "../../packages/server/src/services/agents/agent-executor.js";
import { createAgentPipeline, type ResolvedAgent } from "../../packages/server/src/services/agents/agent-pipeline.js";
import { resolveAgentPipelineAgents } from "../../packages/server/src/services/generation/agent-resolution.js";
import { buildLlamaArgs } from "../../packages/server/src/services/sidecar/sidecar-launch-plan.js";
import {
  BaseLLMProvider,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatOptions,
} from "../../packages/server/src/services/llm/base-provider.js";
import type { AgentContext } from "../../packages/shared/src/types/agent.js";

class RecordingProvider extends BaseLLMProvider {
  calls = 0;
  options: ChatOptions[] = [];

  constructor(private readonly content = JSON.stringify({ text: "ok" })) {
    super("http://localhost", "");
  }

  async *chat(_messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, void, unknown> {
    return;
  }

  override async chatComplete(_messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    this.calls += 1;
    this.options.push(options);
    return {
      content: this.content,
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 12, totalTokens: 112 },
    };
  }
}

const makeAgent = (type: string, resultType = "context_injection"): ResolvedAgent => ({
  id: type,
  type,
  name: type,
  phase: "post_processing",
  promptTemplate: `${type} prompt`,
  connectionId: "connection-1",
  settings: { resultType, contextSize: 4, maxTokens: 512 },
  isCustomAgent: false,
  provider: new RecordingProvider(),
  model: "agent-model",
});

const context: AgentContext = {
  chatId: "agent-runtime-regression",
  chatMode: "roleplay",
  recentMessages: [],
  characters: [],
  persona: null,
  memory: {},
  writableLorebookIds: null,
  chatSummary: null,
  streaming: false,
};

const defaultTemperatureProvider = new RecordingProvider();
await executeAgent(makeAgent("temperature-default"), context, defaultTemperatureProvider, "agent-model");
assert.equal(defaultTemperatureProvider.options[0]?.temperature, 0.7, "unset agent temperature should default to 0.7");

const configuredTemperatureProvider = new RecordingProvider();
await executeAgent(
  {
    ...makeAgent("temperature-configured"),
    temperature: 0.5,
    enabledParameters: { temperature: true },
  },
  context,
  configuredTemperatureProvider,
  "agent-model",
);
assert.equal(configuredTemperatureProvider.options[0]?.temperature, 0.5);
assert.equal(configuredTemperatureProvider.options[0]?.enabledParameters?.temperature, true);

const disabledTemperatureProvider = new RecordingProvider();
await executeAgent(
  {
    ...makeAgent("temperature-disabled"),
    temperature: 0.5,
    enabledParameters: { temperature: false },
  },
  context,
  disabledTemperatureProvider,
  "agent-model",
);
assert.equal(disabledTemperatureProvider.options[0]?.temperature, undefined);

const repairedJsonProvider = new RecordingProvider("```json\n{weather: 'rain', nested: {value: 1}");
const repairedJsonResult = await executeAgent(
  makeAgent("world-state", "game_state_update"),
  context,
  repairedJsonProvider,
  "agent-model",
);
assert.equal(repairedJsonResult.success, true, "structured agents should recover repairable JSON without a retry");
assert.equal(repairedJsonProvider.calls, 1, "repairable JSON should not spend another model call");
assert.deepEqual(repairedJsonResult.data, { weather: "rain", nested: { value: 1 } });

const invalidJsonProvider = new RecordingProvider("not JSON at all");
const invalidJsonResult = await executeAgent(
  makeAgent("world-state", "game_state_update"),
  context,
  invalidJsonProvider,
  "agent-model",
);
assert.equal(invalidJsonResult.success, false, "non-JSON agent output must still fail after the repair attempt");
assert.equal(invalidJsonProvider.calls, 2, "unrepairable JSON should retain the existing single retry");

const arrayJsonProvider = new RecordingProvider('[{"weather":"rain"}]');
const arrayJsonResult = await executeAgent(
  makeAgent("world-state", "game_state_update"),
  context,
  arrayJsonProvider,
  "agent-model",
);
assert.equal(arrayJsonResult.success, false, "structured agent output must be a JSON object, not an array");
assert.equal(arrayJsonProvider.calls, 2, "array-shaped JSON should retain the existing single retry");

const mixedParameterBatchProvider = new RecordingProvider();
await executeAgentBatch(
  [
    {
      ...makeAgent("batch-temperature-low"),
      temperature: 0.2,
      enabledParameters: { temperature: true },
      suppressModelParameters: false,
    },
    {
      ...makeAgent("batch-temperature-high"),
      temperature: 0.8,
      enabledParameters: { temperature: true },
      suppressModelParameters: false,
    },
    {
      ...makeAgent("batch-parameters-suppressed"),
      temperature: 0.4,
      enabledParameters: { temperature: true },
      suppressModelParameters: true,
    },
  ],
  context,
  mixedParameterBatchProvider,
  "agent-model",
);
assert.equal(mixedParameterBatchProvider.calls, 3, "agents with incompatible request options must not share a batch");
assert.deepEqual(
  mixedParameterBatchProvider.options.map((options) => ({
    temperature: options.temperature,
    suppressModelParameters: options.suppressModelParameters ?? false,
  })),
  [
    { temperature: 0.2, suppressModelParameters: false },
    { temperature: 0.8, suppressModelParameters: false },
    { temperature: undefined, suppressModelParameters: true },
  ],
  "split agent requests should retain each agent's temperature and parameter policy",
);

const storedTemperatureResolution = await resolveAgentPipelineAgents({
  connections: {
    getDefaultForAgents: async () => null,
    getFallbackForAgents: async () => null,
    getWithKey: async () => ({
      id: "agent-temperature-connection",
      name: "Agent temperature connection",
      provider: "custom",
      baseUrl: "http://127.0.0.1:65535/v1",
      apiKey: "",
      model: "custom-agent-model",
      maxContext: 32_768,
      defaultParameters: JSON.stringify({
        temperature: 0.55,
        enabledParameters: { temperature: true },
      }),
      maxParallelJobs: 1,
    }),
  } as unknown as Parameters<typeof resolveAgentPipelineAgents>[0]["connections"],
  configuredAgents: [
    {
      ...makeAgent("stored-temperature"),
      connectionId: "agent-temperature-connection",
    },
  ],
  chatId: "stored-agent-temperature",
  chatEnableAgents: true,
  hasPerChatAgentList: false,
  perChatAgentSet: new Set<string>(),
  agentPromptTemplateSelections: {},
  chatProvider: new RecordingProvider(),
  chatConnectionId: "chat-connection",
  chatModel: "agent-model",
  chatCustomParameters: {},
  chatTemperature: 0.9,
  chatEnabledParameters: { temperature: true },
  chatSuppressModelParameters: false,
  chatMaxOutputTokens: null,
  chatMaxParallelJobs: 1,
  chatEnableCaching: false,
  chatAnthropicExtendedCacheTtl: false,
  chatCachingAtDepth: 5,
  resolveBaseUrl: (connection) => connection.baseUrl,
});
assert.equal(storedTemperatureResolution.resolvedAgents[0]?.temperature, 0.55);
assert.equal(storedTemperatureResolution.resolvedAgents[0]?.enabledParameters?.temperature, true);

const spotifyProvider = new RecordingProvider(JSON.stringify({ action: "none", mood: "quiet" }));
let spotifyToolExecutions = 0;
const spotifyAgent: ResolvedAgent = {
  ...makeAgent("spotify", "spotify_control"),
  provider: spotifyProvider,
  toolContext: {
    tools: [
      {
        type: "function",
        function: {
          name: "spotify_search",
          description: "Search Spotify",
          parameters: { type: "object" },
        },
      },
    ],
    executeToolCall: async () => {
      spotifyToolExecutions += 1;
      return JSON.stringify({ tracks: [] });
    },
  },
};
await createAgentPipeline([spotifyAgent], context).postGenerate("The room settles into a quieter mood.");
assert.equal(spotifyProvider.calls, 1, "Spotify Music DJ should make one planning request");
assert.equal(spotifyProvider.options[0]?.tools, undefined, "Spotify planning should not enter the LLM tool loop");
assert.equal(spotifyToolExecutions, 0, "Spotify tools should run later in the deterministic playback stage");

const parallelLlamaArgs = buildLlamaArgs({
  modelPath: "/tmp/model.gguf",
  gpuLayers: 0,
  port: 10_019,
  contextSize: 8_192,
  runtimeVariant: "cpu",
  enableNativeToolCalls: false,
  embeddingPooling: "mean",
  embeddingBatchSize: 512,
  maxParallelJobs: 4,
});
assert.deepEqual(
  parallelLlamaArgs.slice(parallelLlamaArgs.indexOf("--parallel"), parallelLlamaArgs.indexOf("--port")),
  ["--parallel", "4", "--ctx-size", "32768"],
  "local parallel slots should preserve the configured context budget per request",
);

console.log("Agent runtime regression checks passed.");

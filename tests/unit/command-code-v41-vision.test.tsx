// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapabilityEntry } from "../../src/lib/modelsDevSync/transform";

// Keep the real registry, alias resolution, and capability resolver. Only
// persistence and external bridge dependencies are isolated from this regression.
const { getSyncedCapability } = vi.hoisted(() => ({
  getSyncedCapability: vi.fn<(provider: string, model: string) => ModelCapabilityEntry | null>(
    () => null
  ),
}));
vi.mock("@/lib/modelsDevSync", () => ({ getSyncedCapability }));
vi.mock("@/lib/db/modelContextOverrides", () => ({ getModelContextOverride: () => null }));
vi.mock("@/lib/db/modelCapabilityOverrides", () => ({
  getModelCapabilityOverride: () => null,
  getReasoningEffortsOverride: () => null,
}));
vi.mock("@/lib/db/models", () => ({ getCustomModelVisionOverride: () => null }));
vi.mock("@/lib/db/settings", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("@/lib/db/combos", () => ({ getComboByName: vi.fn(async () => null) }));
vi.mock("@/lib/db/modelComboMappings", () => ({ resolveComboForModel: vi.fn(async () => null) }));
vi.mock("@/shared/network/remoteImageFetch", () => ({ fetchRemoteImage: vi.fn() }));
vi.mock("@/shared/middleware/chatBodyAdmission", () => ({ resolveSelfLoopBearer: vi.fn() }));
vi.mock("@/lib/guardrails/visionBridgeRouter", () => ({
  getBestVisionModel: vi.fn(),
  getFallbackModels: vi.fn(),
  recordLatency: vi.fn(),
}));
vi.mock("@/lib/guardrails/visionBridgeCredentials", () => ({
  isProviderConnectionUsable: vi.fn(),
  hasUsableCredentialsForModel: vi.fn(),
}));
vi.mock("@/lib/guardrails/modalityBridge/bridgeStats", () => ({ recordBridgeUse: vi.fn() }));

import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities";
import { VisionBridgeGuardrail } from "../../src/lib/guardrails/visionBridge";
import * as visionBridgeDefaults from "../../src/shared/constants/visionBridgeDefaults";

const MODEL_ID = "deepseek/deepseek-v4.1-flash";
const MODEL_NAMES = [`command-code/${MODEL_ID}`, `cmd/${MODEL_ID}`];

function imagePayload(model: string) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "high" },
          },
        ],
      },
    ],
  };
}

function staleSyncedCapability(): ModelCapabilityEntry {
  return {
    tool_call: null,
    reasoning: null,
    attachment: false,
    structured_output: null,
    temperature: null,
    modalities_input: JSON.stringify(["text"]),
    modalities_output: JSON.stringify(["text"]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(visionBridgeDefaults, "getVisionBridgeConfig");
  getSyncedCapability.mockReturnValue(null);
});

describe.each([false, true])("Command Code V4.1 vision (synced attachment:false = %s)", (stale) => {
  beforeEach(() => {
    if (stale) {
      const capability = staleSyncedCapability();
      getSyncedCapability.mockImplementation((provider, model) =>
        provider === "command-code" && model === MODEL_ID ? capability : null
      );
    }
  });

  it.each(MODEL_NAMES)("resolves native vision for %s", (model) => {
    const capabilities = getResolvedModelCapabilities(model);
    expect(capabilities.provider).toBe("command-code");
    expect(capabilities.model).toBe(MODEL_ID);
    expect(capabilities.supportsVision).toBe(true);
    if (stale) expect(capabilities.attachment).toBe(true);
  });

  it.each(MODEL_NAMES)("skips VisionBridge without reading settings for %s", async (model) => {
    const getSettings = vi.fn(async () => ({
      modalityBridgeVisionEnabled: true,
      modalityBridgeVisionMode: "describe",
      modalityBridgeVisionModel: "openai/gpt-4o-mini",
      modalityBridgeCacheEnabled: false,
    }));
    const callVisionModel = vi.fn(
      async () => "A bridge description that must not replace the image"
    );
    // Do not inject checkModelHasComboMapping:false: it skips independently of
    // native vision. The mocked DB lookups above let the real check return not-combo.
    const guardrail = new VisionBridgeGuardrail({ deps: { getSettings, callVisionModel } });
    const payload = imagePayload(model);
    const snapshot = structuredClone(payload);

    const result = await guardrail.preCall(payload, { model });

    expect(result.block).toBe(false);
    expect(result.modifiedPayload).toBeUndefined();
    expect(payload).toEqual(snapshot);
    expect(getSettings).not.toHaveBeenCalled();
    expect(visionBridgeDefaults.getVisionBridgeConfig).not.toHaveBeenCalled();
    expect(callVisionModel).not.toHaveBeenCalled();
  });
});

it.each(["deepseek-v4-flash", "deepseek-v4-pro"])(
  "does not enable native vision for old %s",
  (id) => {
    for (const provider of ["command-code", "cmd"]) {
      expect(getResolvedModelCapabilities(`${provider}/deepseek/${id}`).supportsVision).not.toBe(
        true
      );
    }
  }
);

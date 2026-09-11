/**
 * OpenCode Go catalog sync (2026-09-11).
 *
 * Models live on https://opencode.ai/zen/go/v1/models but were missing from the
 * Go registry. Wire formats come from the docs endpoint table
 * (https://opencode.ai/docs/go); context/output envelopes from models.dev.
 *
 * A probe with a real Go key (2026-09-11) found that every effort-suffixed model
 * id — `<model>-low`, `-high`, `-max`, … — is rejected with 401 "Model X is not
 * supported" on all three endpoints. Only the DeepSeek family has a working
 * effort mechanism (the executor's rewrite to a flat `reasoning_effort`), so the
 * rows below deliberately declare NO tier vocabulary: a declaration would make
 * the catalog synthesize variant ids that cannot be routed.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { parseEffortLevel, OpencodeExecutor } =
  (await import("../../open-sse/executors/opencode.ts")) as {
    parseEffortLevel: (model: string) => { baseModel: string; effort: string } | null;
    OpencodeExecutor: new (provider: string) => {
      transformRequest: (
        model: string,
        body: Record<string, unknown>,
        stream: boolean,
        credentials: unknown
      ) => Record<string, unknown>;
    };
  };

const { REGISTRY } = (await import("../../open-sse/config/providerRegistry.ts")) as {
  REGISTRY: Record<string, { models?: Array<Record<string, unknown>> }>;
};

const { isVisionBridgeForcedModel } =
  (await import("../../src/shared/constants/visionBridgeDefaults.ts")) as {
    isVisionBridgeForcedModel: (model: string | null | undefined) => boolean;
  };

const CREDENTIALS = { apiKey: "k" } as Record<string, unknown>;
const VISION_EXP_ID = "deepseek-v4-flash-vision-exp";

/** Rows added by the sync: id → the wire format the docs table justifies. */
const SYNCED_MODELS: ReadonlyArray<{ id: string; targetFormat?: string }> = [
  // /responses (@ai-sdk/openai)
  { id: "grok-4.6", targetFormat: "openai-responses" },
  { id: "gpt-5.6-luna", targetFormat: "openai-responses" },
  { id: "muse-spark-1.3-contributor", targetFormat: "openai-responses" },
  // /chat/completions (provider default)
  { id: "glm-5.3" },
  { id: "glm-5.3-flash" },
  { id: "hy4-preview" },
  { id: "longcat-2.0" },
  { id: "mimo-v2-pro" },
  { id: "mimo-v2-omni" },
  { id: VISION_EXP_ID, targetFormat: "openai-responses" },
  // /messages (@ai-sdk/anthropic → Claude translator)
  { id: "qwen3.8-max", targetFormat: "claude" },
  { id: "qwen3.8-flash", targetFormat: "claude" },
  // Wire format absent from the endpoint table — provider default kept.
  { id: "omen-alpha" },
];

/** Models whose effort tiers are routable (flat-field families only). */
const ROUTABLE_EFFORT_MODELS = new Map<string, readonly string[]>([
  [VISION_EXP_ID, ["none", "low", "high", "max"]],
]);

function goModel(id: string): Record<string, unknown> | undefined {
  return REGISTRY["opencode-go"]?.models?.find((model) => model.id === id);
}

for (const { id, targetFormat } of SYNCED_MODELS) {
  test(`opencode-go exposes ${id} with the synced wire format`, () => {
    const row = goModel(id);
    assert.ok(row, `opencode-go must expose ${id}`);
    assert.equal(row.targetFormat, targetFormat);
  });
}

test("synced rows never shadow the dashboard default (models[0] stays glm-5.2)", () => {
  const models = REGISTRY["opencode-go"]?.models || [];
  assert.equal(models[0]?.id, "glm-5.2");
});

// The probe finding, encoded as a guard: declaring tiers for a family whose
// suffix ids are rejected upstream only produces unroutable catalog entries.
test("no synced row declares tiers unless the family can route them", () => {
  for (const { id } of SYNCED_MODELS) {
    const row = goModel(id);
    const declared = row?.supportedThinkingEfforts;
    const routable = ROUTABLE_EFFORT_MODELS.get(id);
    if (routable) {
      assert.deepEqual(declared, [...routable], `${id} must declare its measured tiers`);
    } else {
      assert.equal(declared, undefined, `${id} must not declare unroutable tiers`);
    }
  }
});

test("the schema-qwen rows stay declared without a tier vocabulary", () => {
  // qwen3.8-* went live on /messages; their suffixed ids are rejected upstream,
  // so `parseEffortLevel` must not resolve any tier for them either.
  for (const tier of ["low", "medium", "xhigh"]) {
    assert.equal(parseEffortLevel(`qwen3.8-flash-${tier}`), null);
  }
});

test("Vision Exp is a genuine vision model — never force-bridged", () => {
  const row = goModel(VISION_EXP_ID);
  assert.equal(row?.supportsVision, true);
  assert.equal(isVisionBridgeForcedModel(`opencode-go/${VISION_EXP_ID}`), false);
  // …while its text-only sibling stays bridged (control).
  assert.equal(isVisionBridgeForcedModel("opencode-go/deepseek-v4-flash"), true);
});

test("Vision Exp uses the DeepSeek flat effort contract like its siblings", () => {
  const executor = new OpencodeExecutor("opencode-go");
  for (const effort of ["none", "low", "high", "max"]) {
    const alias = `${VISION_EXP_ID}-${effort}`;
    assert.deepEqual(parseEffortLevel(alias), { baseModel: VISION_EXP_ID, effort });
    const out = executor.transformRequest(
      alias,
      { model: alias, messages: [{ role: "user", content: "hi" }] },
      true,
      CREDENTIALS
    );
    assert.equal(out.model, VISION_EXP_ID);
    assert.equal(out.reasoning_effort, effort);
  }
});

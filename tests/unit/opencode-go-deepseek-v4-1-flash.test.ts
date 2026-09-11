/**
 * DeepSeek V4.1 Flash on the OpenCode Go tier.
 *
 * Live-verified: https://opencode.ai/zen/go/v1/models lists the id, the docs
 * endpoint table (https://opencode.ai/docs/go) documents it, and a probe with a
 * real Go key (2026-09-11) measured its effort vocabulary against the upstream:
 *
 *   none    → accepted, thinking disabled (12-token reply, no reasoning tokens)
 *   low/high/max, minimal, medium, xhigh → accepted
 *   ultra   → rejected (400)
 *   `<model>-<tier>` suffixed ids → rejected (401 "Model X is not supported")
 *
 * The last line is why this model takes the DeepSeek flat-`reasoning_effort`
 * contract instead of an aliased wire id. These tests pin the registry row, the
 * derived aliases, the wire rewrite, the clamp and the spec/vision wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";

const MODEL_ID = "deepseek-v4.1-flash";
const EFFORTS = ["none", "low", "high", "max"] as const;

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

const { sanitizeReasoningEffortForProvider } =
  (await import("../../open-sse/executors/base.ts")) as {
    sanitizeReasoningEffortForProvider: (
      body: Record<string, unknown>,
      provider: string,
      model: string,
      log?: { info?: (tag: string, msg: string) => void } | null
    ) => Record<string, unknown>;
  };

const { REGISTRY } = (await import("../../open-sse/config/providerRegistry.ts")) as {
  REGISTRY: Record<string, { models?: Array<Record<string, unknown>> }>;
};

const { MODEL_SPECS } = (await import("../../src/shared/constants/modelSpecs.ts")) as {
  MODEL_SPECS: Record<string, Record<string, unknown>>;
};

const { isVisionBridgeForcedModel } =
  (await import("../../src/shared/constants/visionBridgeDefaults.ts")) as {
    isVisionBridgeForcedModel: (model: string | null | undefined) => boolean;
  };

const CREDENTIALS = { apiKey: "k" } as Record<string, unknown>;
const noopLog = { info: () => {} };

function goModel(id: string): Record<string, unknown> | undefined {
  return REGISTRY["opencode-go"]?.models?.find((model) => model.id === id);
}

// ─── Registry metadata ─────────────────────────────────────────────────────

test("opencode-go registers DeepSeek V4.1 Flash as a reasoning base row", () => {
  const row = goModel(MODEL_ID);
  assert.ok(row, "opencode-go must expose deepseek-v4.1-flash");
  assert.equal(row.name, "DeepSeek V4.1 Flash");
  assert.equal(row.supportsReasoning, true);
  assert.deepEqual(row.supportedThinkingEfforts, ["none", "low", "high", "max"]);
  // Same Go-tier wire format as its V4 siblings (see #10540); the probe hit both
  // /chat/completions and /responses successfully, so the Responses route stands.
  assert.equal(row.targetFormat, "openai-responses");
});

// ─── Derived effort aliases ────────────────────────────────────────────────

test("parseEffortLevel derives the four declared aliases for V4.1 Flash", () => {
  for (const effort of EFFORTS) {
    assert.deepEqual(parseEffortLevel(`${MODEL_ID}-${effort}`), {
      baseModel: MODEL_ID,
      effort,
    });
  }
});

test("parseEffortLevel rejects tiers outside the declared vocabulary", () => {
  for (const tier of ["minimal", "medium", "xhigh", "thinking", "ultra"]) {
    assert.equal(parseEffortLevel(`${MODEL_ID}-${tier}`), null, `${MODEL_ID}-${tier}`);
  }
  assert.equal(parseEffortLevel(MODEL_ID), null);
});

// ─── Wire rewrite ──────────────────────────────────────────────────────────

test("transformRequest rewrites V4.1 aliases to the base id + flat reasoning_effort", () => {
  const executor = new OpencodeExecutor("opencode-go");
  for (const effort of EFFORTS) {
    const alias = `${MODEL_ID}-${effort}`;
    const body = { model: alias, messages: [{ role: "user", content: "hi" }] };
    const out = executor.transformRequest(alias, body, true, CREDENTIALS);
    assert.equal(out.model, MODEL_ID);
    assert.equal(out.reasoning_effort, effort);
  }
});

test("transformRequest does not clobber a caller-supplied reasoning_effort", () => {
  const executor = new OpencodeExecutor("opencode-go");
  const alias = `${MODEL_ID}-max`;
  const body = {
    model: alias,
    reasoning_effort: "caller-supplied",
    messages: [{ role: "user", content: "hi" }],
  };
  const out = executor.transformRequest(alias, body, true, CREDENTIALS);
  assert.equal(out.model, MODEL_ID);
  assert.equal(out.reasoning_effort, "caller-supplied");
});

// ─── Sanitizer clamp ───────────────────────────────────────────────────────

test("sanitizeReasoningEffortForProvider clamps onto the declared vocabulary", () => {
  const cases = [
    // Accepted verbatim — `none` genuinely disables thinking upstream.
    { requested: "none", expected: "none" },
    { requested: "low", expected: "low" },
    { requested: "high", expected: "high" },
    { requested: "max", expected: "max" },
    // Outside the declared set → nearest accepted tier.
    { requested: "minimal", expected: "low" },
    { requested: "medium", expected: "high" },
    { requested: "xhigh", expected: "max" },
    { requested: "ultra", expected: "max" },
  ] as const;

  for (const { requested, expected } of cases) {
    const out = sanitizeReasoningEffortForProvider(
      { model: MODEL_ID, reasoning_effort: requested, messages: [] },
      "opencode-go",
      MODEL_ID,
      noopLog
    );
    assert.equal(out.reasoning_effort, expected, `${requested} → ${expected}`);
  }
});

// ─── Spec + vision wiring ──────────────────────────────────────────────────

test("MODEL_SPECS carries the V4.1 Flash thinking envelope", () => {
  assert.deepEqual(MODEL_SPECS[MODEL_ID], {
    maxOutputTokens: 384000,
    contextWindow: 1000000,
    thinkingBudgetCap: 380000,
    supportsThinking: true,
    supportsTools: true,
  });
});

test("V4.1 keeps native vision without forcing the V4 text-only bridge", () => {
  assert.equal(goModel(MODEL_ID)?.supportsVision, true);
  assert.equal(isVisionBridgeForcedModel("opencode-go/deepseek-v4.1-flash"), false);
  assert.equal(isVisionBridgeForcedModel("opencode-go/deepseek-v4-flash"), true);
});

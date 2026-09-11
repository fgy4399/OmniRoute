/**
 * DeepSeek V4.1 Flash via the Command Code gateway (`command-code` / `cmd`).
 *
 * Upstream evidence: https://api.commandcode.ai/provider/v1/models (public, no
 * key needed) lists `deepseek/deepseek-v4.1-flash` — "DeepSeek V4.1 Flash",
 * context_length 1000000. Command Code is a gateway for this family: it forwards
 * a flat `reasoning_effort` (see COMMAND_CODE_PASSTHROUGH_FIELDS in
 * open-sse/executors/commandCode.ts), which is why the registry declares the
 * provider's tier vocabulary on the base id instead of relying on suffixed wire
 * ids. These tests pin the row, the sibling effort parity, native vision
 * classification, and catalog exposure.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cmd-ds41-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "cmd-ds41-test-secret";

const MODEL_ID = "deepseek/deepseek-v4.1-flash";
const EXPECTED_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const { REGISTRY } = (await import("../../open-sse/config/providerRegistry.ts")) as {
  REGISTRY: Record<string, { models?: Array<Record<string, unknown>> }>;
};
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

function cmdModel(id: string): Record<string, unknown> | undefined {
  return REGISTRY["command-code"]?.models?.find((model) => model.id === id);
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5 });
});

// ─── Registry metadata ─────────────────────────────────────────────────────

test("command-code registers DeepSeek V4.1 Flash under its vendor-prefixed wire id", () => {
  const row = cmdModel(MODEL_ID);
  assert.ok(row, "command-code must expose deepseek/deepseek-v4.1-flash");
  assert.equal(row.name, "DeepSeek V4.1 Flash (CC)");
  assert.equal(row.supportsReasoning, true);
  assert.deepEqual(row.supportedThinkingEfforts, [...EXPECTED_EFFORTS]);
  // 1M context / 131072 output — mirrored from the upstream discovery payload and
  // the V4 Pro/Flash siblings.
  assert.equal(row.contextLength, 1000000);
  assert.equal(row.maxOutputTokens, 131072);
});

test("V4.1 Flash declares vision without changing older DeepSeek metadata", () => {
  const row = cmdModel(MODEL_ID);
  assert.equal(row.supportsVision, true);
  for (const sibling of ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]) {
    assert.equal(
      cmdModel(sibling)?.supportsVision,
      undefined,
      `${sibling} keeps its existing vision metadata (control)`
    );
  }
});

test("the DeepSeek trio on command-code shares one tier vocabulary", () => {
  const trio = [MODEL_ID, "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"];
  const declared = trio.map((id) => cmdModel(id)?.supportedThinkingEfforts);
  for (const efforts of declared) {
    assert.deepEqual(efforts, [...EXPECTED_EFFORTS]);
  }
});

// ─── Capability resolution ─────────────────────────────────────────────────

for (const provider of ["command-code", "cmd"]) {
  test(`DeepSeek V4.1 Flash and its effort variants resolve native vision via ${provider}`, () => {
    for (const suffix of ["", ...EXPECTED_EFFORTS.map((effort) => `-${effort}`)]) {
      const model = `${provider}/${MODEL_ID}${suffix}`;
      const caps = getResolvedModelCapabilities(model);
      assert.equal(caps.provider, "command-code", model);
      assert.equal(caps.supportsVision, true, `${model} must retain native vision`);
    }
  });
}

// ─── Catalog exposure ──────────────────────────────────────────────────────

test("the catalog lists the model (and its derived tier variants) under cmd/", async () => {
  await providersDb.createProviderConnection({
    provider: "command-code",
    authType: "apikey",
    name: "cmd-ds41",
    apiKey: "cmd-test-key",
    isActive: true,
    testStatus: "active",
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  const ids = new Set((body.data || []).map((model) => String(model.id || "")));

  assert.ok(ids.has(`cmd/${MODEL_ID}`), "cmd/<model> must be listed");
  assert.ok(ids.has(`command-code/${MODEL_ID}`), "command-code/<model> must be listed");
  // Tiers are declared on the base row, so the catalog derives the variants.
  for (const effort of EXPECTED_EFFORTS) {
    assert.ok(ids.has(`cmd/${MODEL_ID}-${effort}`), `cmd/${MODEL_ID}-${effort} must be derived`);
  }
});

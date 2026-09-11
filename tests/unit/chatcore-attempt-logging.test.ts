// tests/unit/chatcore-attempt-logging.test.ts
// Characterization of persistAttemptLogs — the per-attempt call-log persistence extracted from
// handleChatCore (chatCore god-file decomposition, #3501). Uses a real temp DB and polls the
// persisted row (saveCallLog is async + fire-and-forget). Locks: the field mapping, the
// cacheSource semantic/upstream normalization, final credentials.connectionId attribution,
// credentials fallback, and error persistence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-attempt-logging-test-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const { getCallLogById } = await import("../../src/lib/usage/callLogs.ts");
const { persistAttemptLogs } = await import("../../open-sse/handlers/chatCore/attemptLogging.ts");
const { getAuditLog } = await import("../../src/lib/compliance/index.ts");
const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.ts");
const { createPreparedRequestLogger } =
  await import("../../open-sse/utils/providerRequestLogging.ts");

type CodexRotationEnvelope = {
  _omniroute?: {
    codexAccountRotation?: {
      initialConnectionId: unknown;
      finalConnectionId: unknown;
    };
  };
};

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    connectionId: "conn-1",
    model: "gpt-x",
    skillRequestId: "skill-1",
    detailedLoggingEnabled: false,
    reqLogger: null,
    pendingRequestId: "REPLACE",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    requestedModel: "gpt-x-requested",
    credentials: { connectionId: "cred-conn" },
    startTime: Date.now(),
    body: { messages: [{ role: "user", content: "hi" }] },
    sourceFormat: "openai",
    targetFormat: "openai",
    comboName: null,
    comboStepId: null,
    comboExecutionKey: null,
    tokensCompressed: 0,
    apiKeyInfo: { id: "key-1", name: "Key One" },
    noLogEnabled: false,
    ...overrides,
  } as Parameters<typeof persistAttemptLogs>[1];
}

async function pollForCallLog(id: string, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const row = await getCallLogById(id);
    if (row) return row as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

function getCodexAccountRotation(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  return (value as CodexRotationEnvelope)._omniroute?.codexAccountRotation;
}

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("persists a call log row with the mapped fields (default cacheSource=upstream)", async () => {
  const id = "attempt-basic-1";
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 } },
    baseCtx({ pendingRequestId: id, credentials: { connectionId: "conn-1" } })
  );
  const row = await pollForCallLog(id);
  assert.ok(row, "call log row should be persisted");
  assert.equal(row.status, 200);
  assert.equal(row.model, "gpt-x");
  assert.equal(row.provider, "openai");
  assert.equal(row.requestedModel, "gpt-x-requested");
  assert.equal(row.connectionId, "conn-1");
  assert.equal(row.cacheSource, "upstream");
});

test("uses final credentials connectionId when Codex failover rotates the account", async () => {
  const id = "attempt-codex-rotation-1";
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 }, responseBody: { id: "response-1" } },
    baseCtx({
      pendingRequestId: id,
      provider: "codex",
      connectionId: "initial-conn",
      credentials: { connectionId: "final-conn" },
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.connectionId, "final-conn");
  assert.deepEqual(getCodexAccountRotation(row.requestBody), {
    initialConnectionId: "initial-conn",
    finalConnectionId: "final-conn",
  });
  assert.deepEqual(getCodexAccountRotation(row.responseBody), {
    initialConnectionId: "initial-conn",
    finalConnectionId: "final-conn",
  });
});

test("semantic cache hits persist NULL effort even when logger metadata has a tier", async () => {
  const id = "attempt-semantic-1";
  persistAttemptLogs(
    { status: 200, cacheSource: "semantic" },
    baseCtx({
      pendingRequestId: id,
      reqLogger: { getFinalProviderRequestMetadata: () => ({ reasoningEffort: "high" }) },
    })
  );
  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.cacheSource, "semantic");
  assert.equal(row.reasoningEffort, null);
});

test("connectionId falls back to credentials.connectionId when null, and error is persisted", async () => {
  const id = "attempt-fallback-1";
  persistAttemptLogs(
    { status: 502, error: "upstream boom" },
    baseCtx({ pendingRequestId: id, connectionId: null })
  );
  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.connectionId, "cred-conn");
  assert.equal(row.status, 502);
  assert.match(String(row.error ?? ""), /upstream boom/);
});

function duplicateHeartbeatBody() {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: "heartbeat_respond", arguments: "{}" } },
            { function: { name: "heartbeat_respond", arguments: "{}" } },
          ],
        },
      },
    ],
  };
}

test("duplicate tool_calls in the assembled body writes provider.spec_violation audit", () => {
  persistAttemptLogs(
    { status: 200, responseBody: duplicateHeartbeatBody() },
    baseCtx({ pendingRequestId: "attempt-spec-violation-1", skillRequestId: "skill-spec-1" })
  );
  // logAuditEvent is synchronous; do not wait on the fire-and-forget saveCallLog.
  const rows = getAuditLog({ action: "provider.spec_violation", requestId: "skill-spec-1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.resourceType, "provider_spec_violation");
  const details = rows[0]?.details;
  assert.ok(details && typeof details === "object");
  assert.equal(
    (details as { violation?: string }).violation,
    'duplicate tool_calls entry for "heartbeat_respond"'
  );
});

test("unique tool_calls do not write provider.spec_violation audit", () => {
  persistAttemptLogs(
    {
      status: 200,
      responseBody: {
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "heartbeat_respond", arguments: "{}" } },
                { function: { name: "other_tool", arguments: "{}" } },
              ],
            },
          },
        ],
      },
    },
    baseCtx({ pendingRequestId: "attempt-spec-clean-1", skillRequestId: "skill-spec-clean-1" })
  );
  const rows = getAuditLog({
    action: "provider.spec_violation",
    requestId: "skill-spec-clean-1",
  });
  assert.equal(rows.length, 0);
});

// ─── reasoning_effort (migration 176) ──────────────────────────────────────
// The row must carry the tier the provider request actually held — i.e. what the
// reasoning sanitizer left on the FINAL upstream body — and NULL when the
// request carried none. This is the per-call answer to "which effort did we
// really send?".

async function createCaptureHarness(id: string, enabled = false) {
  const reqLogger = await createRequestLogger("openai", "openai", "gpt-x", { enabled });
  const requestCapture = createPreparedRequestLogger(reqLogger, {
    id,
    model: "gpt-x",
    provider: "openai",
    connectionId: "conn-1",
  });
  return {
    reqLogger,
    capture(body: Record<string, unknown>) {
      return requestCapture.capture({
        url: "https://api.example.com/v1/chat/completions",
        headers: {},
        body,
        bodyString: JSON.stringify(body),
      });
    },
  };
}

test("disabled detailed logging persists captured max effort instead of client xhigh", async () => {
  const id = "attempt-reasoning-effort-1";
  const { reqLogger, capture } = await createCaptureHarness(id);
  const clientBody = {
    model: "deepseek/deepseek-v4.1-flash",
    reasoning_effort: "xhigh",
    messages: [{ role: "user", content: "private prompt" }],
  };
  assert.equal(reqLogger.getFinalProviderRequestMetadata?.(), null);
  reqLogger.logClientRawRequest("/v1/chat/completions", clientBody);
  await capture({ ...clientBody, reasoning_effort: "max" });
  assert.deepEqual(reqLogger.getFinalProviderRequestMetadata?.(), { reasoningEffort: "max" });
  assert.equal(
    reqLogger.getPipelinePayloads(),
    null,
    "disabled logging retains no prompt payloads"
  );
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 }, providerRequest: clientBody },
    baseCtx({ pendingRequestId: id, body: clientBody, reqLogger })
  );

  const row = await pollForCallLog(id);
  assert.ok(row, "call log row should be persisted");
  assert.equal(row.reasoningEffort, "max");
});

test("persists NULL reasoning effort when the captured request carried no tier", async () => {
  const id = "attempt-reasoning-effort-none-1";
  const { reqLogger, capture } = await createCaptureHarness(id);
  await capture({ model: "gpt-5.5", messages: [] });
  assert.deepEqual(reqLogger.getFinalProviderRequestMetadata?.(), { reasoningEffort: null });
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 } },
    baseCtx({ pendingRequestId: id, reqLogger })
  );

  const row = await pollForCallLog(id);
  assert.ok(row, "call log row should be persisted");
  assert.equal(row.reasoningEffort, null);
});

test("persists captured native Claude effort when the executor body is absent", async () => {
  const id = "attempt-reasoning-effort-captured-1";
  const { reqLogger, capture } = await createCaptureHarness(id, true);
  await capture({ model: "claude-opus-4-7", output_config: { effort: "high" } });
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 } },
    baseCtx({ pendingRequestId: id, detailedLoggingEnabled: true, reqLogger })
  );

  const row = await pollForCallLog(id);
  assert.ok(row, "call log row should be persisted");
  assert.equal(row.reasoningEffort, "high");
});

test("records a captured explicit thinking off-switch as none", async () => {
  const id = "attempt-reasoning-effort-off-1";
  const { reqLogger, capture } = await createCaptureHarness(id);
  await capture({ model: "claude-sonnet-5", thinking: { type: "disabled" } });
  persistAttemptLogs({ status: 200 }, baseCtx({ pendingRequestId: id, reqLogger }));

  const row = await pollForCallLog(id);
  assert.ok(row, "call log row should be persisted");
  assert.equal(row.reasoningEffort, "none");
});

for (const detailedLoggingEnabled of [false, true]) {
  test(`retry clears effort (detailed=${detailedLoggingEnabled})`, async () => {
    const id = `attempt-reasoning-effort-retry-${detailedLoggingEnabled}`;
    const { reqLogger, capture } = await createCaptureHarness(id, detailedLoggingEnabled);
    const staleBody = { model: "gpt-5.5", reasoning_effort: "high", messages: [] };
    await capture(staleBody);
    await capture({ model: "gpt-5.5", messages: [] });
    reqLogger.logTargetRequest("https://api.example.com/v1/chat/completions", {}, staleBody);
    persistAttemptLogs(
      { status: 502, error: "upstream failed", providerRequest: staleBody },
      baseCtx({ pendingRequestId: id, detailedLoggingEnabled, reqLogger })
    );

    const row = await pollForCallLog(id);
    assert.ok(row);
    assert.equal(row.reasoningEffort, null);
  });
}

test("failure before dispatch persists NULL despite speculative bodies", async () => {
  const id = "attempt-reasoning-effort-no-dispatch-1";
  const { reqLogger } = await createCaptureHarness(id, true);
  const translatedBody = { model: "gpt-5.5", reasoning_effort: "high", messages: [] };
  reqLogger.logTargetRequest("https://api.example.com/v1/chat/completions", {}, translatedBody);
  assert.equal(reqLogger.getFinalProviderRequestMetadata?.(), null);
  persistAttemptLogs(
    { status: 500, error: "failed before dispatch", providerRequest: translatedBody },
    baseCtx({ pendingRequestId: id, detailedLoggingEnabled: true, reqLogger })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.reasoningEffort, null);
});

test("body mutation and stale logTargetRequest preserve captured effort", async () => {
  const id = "attempt-reasoning-effort-stale-detail-1";
  const { reqLogger, capture } = await createCaptureHarness(id, true);
  const providerBody = { model: "deepseek/deepseek-v4.1-flash", reasoning_effort: "max" };
  await capture(providerBody);
  providerBody.reasoning_effort = "xhigh";
  reqLogger.logTargetRequest("https://api.example.com/v1/chat/completions", {}, providerBody);
  persistAttemptLogs(
    { status: 200, providerRequest: providerBody },
    baseCtx({ pendingRequestId: id, detailedLoggingEnabled: true, reqLogger })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.reasoningEffort, "max");
});

test("legacy logger without capture metadata ignores detailed payloads", async () => {
  const id = "attempt-reasoning-effort-legacy-1";
  const providerBody = { model: "gpt-5.5", reasoning_effort: "high" };
  persistAttemptLogs(
    { status: 200, providerRequest: providerBody },
    baseCtx({
      pendingRequestId: id,
      detailedLoggingEnabled: true,
      reqLogger: { getPipelinePayloads: () => ({ providerRequest: { body: providerBody } }) },
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.reasoningEffort, null);
});

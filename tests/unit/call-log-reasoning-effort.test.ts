/**
 * call_logs.reasoning_effort (migration 176) — the reasoning-effort tier that was
 * ACTUALLY transmitted upstream, so the request log shows the effective value
 * after OmniRoute's reasoning sanitizer rewrote the client's request
 * (xhigh → max, `none` → the model's floor, nearest-tier clamps, …) instead of
 * only the client's requested tier.
 *
 * Covers: the schema change, the reader helper's carrier precedence, and the
 * round trip through saveCallLog → getCallLogs/getCallLogById.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeReasoningEffortForProvider } from "../../open-sse/executors/base.ts";
import { getDbInstance } from "../../src/lib/db/core.ts";
import { saveCallLog, getCallLogs, getCallLogById } from "../../src/lib/usage/callLogs.ts";
import { readEffectiveReasoningEffort } from "../../open-sse/utils/effectiveReasoningEffort.ts";

// ─── Schema ────────────────────────────────────────────────────────────────

test("call_logs has the reasoning_effort column (migration 176)", () => {
  const db = getDbInstance();
  const columns = db.prepare("PRAGMA table_info(call_logs)").all() as Array<{ name: string }>;
  const names = columns.map((column) => column.name);
  assert.ok(
    names.includes("reasoning_effort"),
    "call_logs should have reasoning_effort column — a migration or ensureCallLogsColumns() is missing"
  );
});

// ─── Reader helper: carrier precedence + defensive shapes ──────────────────

test("readEffectiveReasoningEffort reads the flat OpenAI carrier", () => {
  assert.equal(readEffectiveReasoningEffort({ reasoning_effort: "high" }), "high");
});

test("readEffectiveReasoningEffort reads the Responses and Anthropic carriers", () => {
  assert.equal(readEffectiveReasoningEffort({ reasoning: { effort: "max" } }), "max");
  assert.equal(readEffectiveReasoningEffort({ output_config: { effort: "Medium" } }), "medium");
  assert.equal(readEffectiveReasoningEffort({ effort: "low" }), "low");
});

test("readEffectiveReasoningEffort prefers the flat carrier when several are present", () => {
  // Mirrors the sanitizer's own read precedence (readEffortCarriers).
  const body = {
    reasoning_effort: "max",
    reasoning: { effort: "low" },
    output_config: { effort: "high" },
  };
  assert.equal(readEffectiveReasoningEffort(body), "max");
});

test("readEffectiveReasoningEffort records an explicit thinking off-switch as none", () => {
  assert.equal(readEffectiveReasoningEffort({ thinking: { type: "disabled" } }), "none");
  assert.equal(readEffectiveReasoningEffort({ thinking: false }), "none");
});

test("readEffectiveReasoningEffort does not invent a tier for budget-only thinking", () => {
  // A budget is not a tier; recording one would misreport what was sent.
  assert.equal(
    readEffectiveReasoningEffort({ thinking: { type: "enabled", budget_tokens: 2048 } }),
    null
  );
});

test("readEffectiveReasoningEffort returns null for bodies without any effort field", () => {
  for (const body of [undefined, null, 42, "high", [], {}, { model: "gpt-5.5" }]) {
    assert.equal(readEffectiveReasoningEffort(body), null, JSON.stringify(body));
  }
});

test("readEffectiveReasoningEffort normalizes and bounds the stored value", () => {
  assert.equal(readEffectiveReasoningEffort({ reasoning_effort: "  HIGH  " }), "high");
  assert.equal(readEffectiveReasoningEffort({ reasoning_effort: "" }), null);
  assert.equal(readEffectiveReasoningEffort({ reasoning_effort: 7 }), null);
  // Guards the TEXT column against a pathological client-supplied value.
  assert.equal(readEffectiveReasoningEffort({ reasoning_effort: "x".repeat(64) }), null);
});

// ─── Persistence round trip ────────────────────────────────────────────────

test("saveCallLog persists the transmitted effort after the sanitizer's rewrite", async () => {
  const db = getDbInstance();
  const testId = `test-effort-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "deepseek/deepseek-v4.1-flash",
    provider: "command-code",
    duration: 900,
    tokens: { in: 20, out: 8 },
    // What the client asked for was `xhigh`; the sanitizer sent `max`.
    reasoningEffort: "max",
  });

  const row = db
    .prepare("SELECT id, reasoning_effort FROM call_logs WHERE id = ?")
    .get(testId) as Record<string, unknown>;
  assert.ok(row, "row should exist");
  assert.equal(row.reasoning_effort, "max");

  db.prepare("DELETE FROM call_logs WHERE id = ?").run(testId);
});

test("saveCallLog stores NULL when the request carried no tier", async () => {
  const db = getDbInstance();
  const testId = `test-effort-null-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 10,
    tokens: { in: 1, out: 1 },
  });

  const row = db
    .prepare("SELECT reasoning_effort FROM call_logs WHERE id = ?")
    .get(testId) as Record<string, unknown>;
  assert.equal(row.reasoning_effort, null);

  db.prepare("DELETE FROM call_logs WHERE id = ?").run(testId);
});

test("getCallLogById exposes reasoningEffort on the mapped entry", async () => {
  const db = getDbInstance();
  const testId = `test-effort-read-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 12,
    tokens: { in: 2, out: 2 },
    reasoningEffort: "low",
  });

  const entry = (await getCallLogById(testId)) as Record<string, unknown> | null;
  assert.ok(entry, "entry should resolve");
  assert.equal(entry.reasoningEffort, "low");

  // …and the list query maps it the same way (SELECT cl.* path).
  const listed = (await getCallLogs({ limit: 50 })) as Array<Record<string, unknown>>;
  const listedEntry = listed.find((row) => row.id === testId);
  assert.ok(listedEntry, "row should appear in getCallLogs()");
  assert.equal(listedEntry.reasoningEffort, "low");

  db.prepare("DELETE FROM call_logs WHERE id = ?").run(testId);
});

// ─── Sanitizer ↔ log parity ────────────────────────────────────────────────
// The point of the column: it must show what the sanitizer SENT, not what the
// client asked for. These two cases pin the pair (sanitizer writes → reader
// reads) for a rewrite (xhigh → max) and for a registry clamp.

test("the logged tier is the sanitizer's rewrite, not the client's request", () => {
  const log = { info: () => {} };
  const sanitized = sanitizeReasoningEffortForProvider(
    { model: "deepseek/deepseek-v4.1-flash", reasoning_effort: "xhigh", messages: [] },
    "cmd",
    "deepseek/deepseek-v4.1-flash",
    log
  );
  assert.equal(
    (sanitized as Record<string, unknown>).reasoning_effort,
    "max",
    "precondition: cmd maps xhigh → max"
  );
  assert.equal(readEffectiveReasoningEffort(sanitized), "max");
});

test("the logged tier reflects a clamp onto the model's declared vocabulary", () => {
  const log = { info: () => {} };
  const sanitized = sanitizeReasoningEffortForProvider(
    { model: "deepseek-v4.1-flash", reasoning_effort: "medium", messages: [] },
    "opencode-go",
    "deepseek-v4.1-flash",
    log
  );
  assert.equal(
    (sanitized as Record<string, unknown>).reasoning_effort,
    "high",
    "precondition: declared none/low/high/max clamps medium → high"
  );
  assert.equal(readEffectiveReasoningEffort(sanitized), "high");
});

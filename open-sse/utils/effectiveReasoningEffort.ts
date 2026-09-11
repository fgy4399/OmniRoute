/**
 * Read the reasoning-effort tier that is ACTUALLY transmitted to the upstream
 * from a final provider request body.
 *
 * Purpose: the request log needs the effective tier, not the client's request.
 * By the time a body reaches the provider, OmniRoute's reasoning sanitizer may
 * have rewritten the client's value (`xhigh` → `max`, `medium` → `high`, `none`
 * → the model's floor, or a nearest-tier clamp onto the registry's declared
 * `supportedThinkingEfforts` vocabulary), and different wire formats steer
 * reasoning through different carriers. This helper reads whichever carrier the
 * body actually carries, in the same precedence the sanitizer itself uses
 * (`readEffortCarriers` in open-sse/executors/base/reasoningEffort.ts):
 *
 *   1. `reasoning_effort`  — OpenAI chat/completions style (also what the
 *      DeepSeek family on opencode-go/command-code receives)
 *   2. `reasoning.effort`  — OpenAI Responses style
 *   3. `output_config.effort` — native Anthropic / Claude-Code style
 *   4. `effort`            — passthrough gateways that forward it verbatim
 *   5. `thinking`          — budget-style carriers transmit no tier, so only an
 *      explicit off-switch is recorded (`type: "disabled"` / `thinking: false`
 *      → `none`); a budget-only request records nothing rather than inventing a
 *      tier that was never sent.
 *
 * Returns the lowercased tier, or null when the body carries no effort field.
 */

/** Guards against pathological values ending up in a TEXT column. */
const MAX_EFFORT_LENGTH = 32;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_EFFORT_LENGTH) return null;
  return trimmed;
}

function isThinkingDisabled(value: unknown): boolean {
  if (value === false) return true;
  const record = asRecord(value);
  if (!record) return false;
  const type = normalizeEffort(record.type);
  return type === "disabled" || type === "off" || type === "none";
}

export function readEffectiveReasoningEffort(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;

  const flat = normalizeEffort(record.reasoning_effort);
  if (flat) return flat;

  const nested = normalizeEffort(asRecord(record.reasoning)?.effort);
  if (nested) return nested;

  const outputConfig = normalizeEffort(asRecord(record.output_config)?.effort);
  if (outputConfig) return outputConfig;

  const passthrough = normalizeEffort(record.effort);
  if (passthrough) return passthrough;

  if (isThinkingDisabled(record.thinking)) return "none";

  return null;
}

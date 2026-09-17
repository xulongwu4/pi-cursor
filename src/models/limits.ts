/**
 * Context-window and output-token ceilings for Cursor models.
 *
 * Cursor's `ModelDetails` carries neither number, so both start out inferred from
 * the model id and display name. The context window is then corrected by
 * observation: every conversation checkpoint carries the server-enforced limit in
 * `ConversationTokenDetails.max_tokens`, which is recorded here and preferred over
 * the guess from then on. Kept free of transport imports because the model catalog
 * needs it at startup.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { cacheFilePath } from "../utils/cache-dir.js";

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export function inferCursorContextWindow(id: string, name: string): number {
  const text = `${id} ${name}`.toLowerCase();
  if (/\b1\s*m\b|(?:^|-)1m(?:-|$)/.test(text)) return 1_000_000;
  if (/\b272\s*k\b|(?:^|-)272k(?:-|$)/.test(text)) return 272_000;
  return DEFAULT_CONTEXT_WINDOW;
}

// ── Observed context windows ──

/**
 * Cache of windows Cursor actually enforced, keyed by the pi-side model id so
 * variants that differ only by request parameters (max mode, `context=1m`) keep
 * separate entries — the same base model reports a different ceiling under each.
 */
const OBSERVED_WINDOWS_FILE = "context-windows.json";
const OBSERVED_WINDOWS_VERSION = 1;

let observedWindows: Map<string, number> | undefined;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function loadObservedWindows(): Map<string, number> {
  if (observedWindows) return observedWindows;
  observedWindows = new Map();
  const path = cacheFilePath(OBSERVED_WINDOWS_FILE);
  if (!path) return observedWindows;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      windows?: Record<string, unknown>;
    };
    if (parsed?.version !== OBSERVED_WINDOWS_VERSION) return observedWindows;
    for (const [modelId, window] of Object.entries(parsed.windows ?? {})) {
      if (isPositiveInteger(window)) observedWindows.set(modelId, window);
    }
  } catch {
    // Missing or corrupt cache: fall back to inference rather than fail startup.
  }
  return observedWindows;
}

/** The window Cursor last enforced for this model id, if one was ever seen. */
export function observedContextWindow(modelId: string): number | undefined {
  return loadObservedWindows().get(modelId);
}

/**
 * Record `ConversationTokenDetails.max_tokens` for a model. Called on every
 * checkpoint, so the unchanged case must stay free: only a new value writes.
 */
export function recordObservedContextWindow(modelId: string | undefined, maxTokens: unknown): void {
  if (!modelId || !isPositiveInteger(maxTokens)) return;
  const windows = loadObservedWindows();
  if (windows.get(modelId) === maxTokens) return;
  windows.set(modelId, maxTokens);
  const path = cacheFilePath(OBSERVED_WINDOWS_FILE);
  if (!path) return;
  try {
    const data = {
      version: OBSERVED_WINDOWS_VERSION,
      windows: Object.fromEntries([...windows].sort(([a], [b]) => a.localeCompare(b))),
    };
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Read-only cache dir: keep the value in memory for this process.
  }
}

/** Test helper: drop the memoized cache so a fresh cache dir is picked up. */
export function resetObservedContextWindowsForTests(): void {
  observedWindows = undefined;
}

/**
 * Pi-side budgeting metadata only: the Cursor run request has no max-output
 * field, so a wrong value here cannot fail a request upstream — it only
 * mis-sizes Pi's output allowance.
 *
 * Conservative by design. Only families whose provider documents a ceiling above
 * 64K are raised; everything else keeps the 64K floor Cursor's older models use.
 */
export function inferCursorMaxOutputTokens(id: string, name: string): number {
  const text = `${id} ${name}`.toLowerCase();
  // Claude 4.6 and newer (Opus/Sonnet) document a 128K output ceiling. Claude 4.5
  // and earlier — Haiku 4.5 included — stay at 64K.
  if (/claude-(?:[5-9]|4\.(?:[6-9]|\d{2,}))/.test(text)) return 128_000;
  // Cursor labels these "Opus 4.6" / "Sonnet 4.6" rather than "claude-4.6-*".
  if (/\b(?:sonnet|opus)\s*(?:[5-9]|4\.(?:[6-9]|\d{2,}))/.test(text)) return 128_000;
  if (/\bgpt-5/.test(text)) return 128_000;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  inferCursorContextWindow,
  inferCursorMaxOutputTokens,
  observedContextWindow,
  recordObservedContextWindow,
  resetObservedContextWindowsForTests,
} from "../src/models/limits.js";
import { resetCacheDirForTests } from "../src/utils/cache-dir.js";
import { FALLBACK_MODELS } from "../src/models/parameterized.js";

describe("inferCursorContextWindow", () => {
  it("reads the 1M marker from either the id or the display name", () => {
    expect(inferCursorContextWindow("claude-4-sonnet-1m", "Sonnet 4 1M")).toBe(1_000_000);
    expect(inferCursorContextWindow("claude-4.5-sonnet", "Sonnet 4.5 1M")).toBe(1_000_000);
    expect(inferCursorContextWindow("gpt-5.5-1m-high", "GPT-5.5 1M High")).toBe(1_000_000);
  });

  it("reads the 272K marker and otherwise falls back to 200K", () => {
    expect(inferCursorContextWindow("gpt-5.5-high", "GPT-5.5 272K High")).toBe(272_000);
    expect(inferCursorContextWindow("composer-2", "Composer 2")).toBe(200_000);
  });
});

describe("inferCursorMaxOutputTokens", () => {
  it("raises Claude 4.6+ to 128K", () => {
    expect(inferCursorMaxOutputTokens("claude-4.6-opus-high", "Opus 4.6 1M")).toBe(128_000);
    expect(inferCursorMaxOutputTokens("claude-4.6-sonnet-medium", "Sonnet 4.6 1M")).toBe(128_000);
  });

  it("raises the GPT-5 family to 128K", () => {
    expect(inferCursorMaxOutputTokens("gpt-5.5-high", "GPT-5.5 272K High")).toBe(128_000);
    expect(inferCursorMaxOutputTokens("gpt-5-mini", "GPT-5 Mini")).toBe(128_000);
  });

  it("leaves Claude 4.5 and older, and every other family, at the 64K floor", () => {
    for (const [id, name] of [
      ["claude-4-sonnet", "Sonnet 4"],
      ["claude-4.5-sonnet", "Sonnet 4.5 1M"],
      ["claude-4.5-opus-high", "Opus 4.5"],
      ["claude-4.5-haiku", "Haiku 4.5"],
      ["composer-2", "Composer 2"],
      ["gemini-3.1-pro", "Gemini 3.1 Pro"],
      ["grok-4-20", "Grok 4.20"],
      ["kimi-k2.5", "Kimi K2.5"],
      ["default", "Auto"],
    ] as const) {
      expect(inferCursorMaxOutputTokens(id, name)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    }
  });
});

describe("bundled fallback catalog", () => {
  // The catalog is a snapshot of a live discovery response and had drifted: every
  // "1M" Claude row claimed a 200K window. Both columns are derived now, so this
  // guards the derivation rather than the file.
  it("derives both limit columns from the model id and name", () => {
    for (const model of FALLBACK_MODELS) {
      expect(model.contextWindow).toBe(inferCursorContextWindow(model.id, model.name));
      expect(model.maxTokens).toBe(inferCursorMaxOutputTokens(model.id, model.name));
    }
  });

  it("reports the full window for the 1M Claude rows", () => {
    const oneMillion = FALLBACK_MODELS.filter((m) => /\b1M\b/.test(m.name));
    expect(oneMillion.length).toBeGreaterThan(0);
    for (const model of oneMillion) expect(model.contextWindow).toBe(1_000_000);
  });
});

describe("observed context windows", () => {
  const previousCacheDir = process.env.PI_CURSOR_CACHE_DIR;

  function useTempCacheDir(): void {
    process.env.PI_CURSOR_CACHE_DIR = mkdtempSync(join(tmpdir(), "pi-cursor-windows-"));
    resetCacheDirForTests();
    resetObservedContextWindowsForTests();
  }

  afterAll(() => {
    if (previousCacheDir === undefined) delete process.env.PI_CURSOR_CACHE_DIR;
    else process.env.PI_CURSOR_CACHE_DIR = previousCacheDir;
    resetCacheDirForTests();
    resetObservedContextWindowsForTests();
  });

  it("survives a restart so a model is only mis-sized before its first turn", () => {
    useTempCacheDir();
    // The guess for this id is the 200K default; Cursor reported something else.
    expect(inferCursorContextWindow("composer-2", "Composer 2")).toBe(200_000);
    recordObservedContextWindow("composer-2", 123_456);

    // Drop the in-memory map: a later process must read the value back off disk.
    resetObservedContextWindowsForTests();
    expect(observedContextWindow("composer-2")).toBe(123_456);
  });

  it("keys variants separately and ignores values Cursor cannot have meant", () => {
    useTempCacheDir();
    recordObservedContextWindow("gpt-5.5-high", 272_000);
    recordObservedContextWindow("gpt-5.5-1m-high", 1_000_000);
    expect(observedContextWindow("gpt-5.5-high")).toBe(272_000);
    expect(observedContextWindow("gpt-5.5-1m-high")).toBe(1_000_000);

    for (const bad of [0, -1, 1.5, undefined, "272000"]) {
      recordObservedContextWindow("composer-2", bad);
    }
    expect(observedContextWindow("composer-2")).toBeUndefined();
  });
});

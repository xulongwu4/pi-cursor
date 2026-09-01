import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

import cursorExtension from "../src/index.js";
import {
  DEFAULT_CURSOR_AGENT_URL,
  getCursorInferenceUrl,
  resetCursorAgentUrlCacheForTests,
} from "../src/config/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-cursor-route-config-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.CURSOR_CONFIG_DIR = join(root, "empty-cursor-config");
  delete process.env.PI_CURSOR_AGENT_URL;
  delete process.env.CURSOR_AGENT_URL;
  resetCursorAgentUrlCacheForTests();
});

afterEach(() => {
  unregisterApiProviders("@rahularya01/pi-cursor");
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.CURSOR_CONFIG_DIR;
  delete process.env.PI_CURSOR_AGENT_URL;
  delete process.env.CURSOR_AGENT_URL;
  resetCursorAgentUrlCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

function writeModels(path: string, cursor: { baseUrl: string; routeMarker?: string }): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ providers: { cursor } }));
}

describe("Cursor inference URL", () => {
  it("wraps the canonical endpoint with models.json baseUrl and routeMarker", () => {
    writeModels(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), {
      baseUrl: "http://localhost:8788/",
      routeMarker: "/route_to/",
    });

    expect(getCursorInferenceUrl()).toBe(
      `http://localhost:8788/route_to/${DEFAULT_CURSOR_AGENT_URL}`,
    );
  });

  it("keeps the activated inference URL stable until restart", () => {
    const modelsPath = join(process.env.PI_CODING_AGENT_DIR!, "models.json");
    writeModels(modelsPath, { baseUrl: "http://localhost:8788" });
    expect(getCursorInferenceUrl()).toBe("http://localhost:8788");

    writeModels(modelsPath, { baseUrl: "http://localhost:9999" });
    expect(getCursorInferenceUrl()).toBe("http://localhost:8788");

    resetCursorAgentUrlCacheForTests();
    expect(getCursorInferenceUrl()).toBe("http://localhost:9999");
  });

  it("keeps the explicit agent URL environment override highest priority", () => {
    process.env.PI_CURSOR_AGENT_URL = "http://localhost:7777";
    writeModels(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), {
      baseUrl: "http://localhost:8788",
      routeMarker: "route_to",
    });

    expect(getCursorInferenceUrl()).toBe("http://localhost:7777");
  });

  it("stamps the routed URL onto every registered Cursor model", () => {
    writeModels(join(process.env.PI_CODING_AGENT_DIR!, "models.json"), {
      baseUrl: "http://localhost:8788",
      routeMarker: "route_to",
    });
    let provider: ProviderConfig | undefined;
    const pi = {
      on() {},
      registerCommand() {},
      registerProvider(_id: string, config: ProviderConfig) {
        provider = config;
      },
    } as unknown as ExtensionAPI;

    cursorExtension(pi);

    expect(provider?.models?.length).toBeGreaterThan(0);
    expect(provider?.models?.every((model) => model.baseUrl === getCursorInferenceUrl())).toBe(
      true,
    );
  });
});

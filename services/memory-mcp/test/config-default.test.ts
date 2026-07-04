// AC-022: an UNSET contextual model env (VOYAGE_CONTEXT_MODEL) must fall back to the
// documented default and the service must start cleanly — i.e. assertServerConfig must
// NOT require it. config is read at import time, so we reset modules between cases.

import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("contextModel config default (AC-022)", () => {
  it("falls back to voyage-context-4 when VOYAGE_CONTEXT_MODEL is unset", async () => {
    vi.resetModules();
    delete process.env.VOYAGE_CONTEXT_MODEL;
    const { config } = await import("../src/config.js");
    expect(config.contextModel).toBe("voyage-context-4");
  });

  it("honors VOYAGE_CONTEXT_MODEL when set", async () => {
    vi.resetModules();
    process.env.VOYAGE_CONTEXT_MODEL = "voyage-context-3-custom";
    const { config } = await import("../src/config.js");
    expect(config.contextModel).toBe("voyage-context-3-custom");
  });

  it("legacy embedModel still defaults to voyage-4-large", async () => {
    vi.resetModules();
    delete process.env.VOYAGE_EMBED_MODEL;
    const { config } = await import("../src/config.js");
    expect(config.embedModel).toBe("voyage-4-large");
  });

  it("consolidateModel treats an EMPTY env string as unset (compose `${VAR:-}` materializes empty)", async () => {
    vi.resetModules();
    process.env.CONSOLIDATE_MODEL = "";
    const { config } = await import("../src/config.js");
    expect(config.consolidateModel).toBe("claude-haiku-4-5");
  });

  it("distillModel falls through empty DISTILL_MODEL and empty CONSOLIDATE_MODEL", async () => {
    vi.resetModules();
    process.env.DISTILL_MODEL = "";
    process.env.CONSOLIDATE_MODEL = "";
    const { config } = await import("../src/config.js");
    expect(config.distillModel).toBe("claude-haiku-4-5");
  });

  it("assertServerConfig does NOT require the context model (starts cleanly)", async () => {
    vi.resetModules();
    delete process.env.VOYAGE_CONTEXT_MODEL;
    process.env.DATABASE_URL = "postgres://x/y";
    process.env.VOYAGE_API_KEY = "test-key";
    const { assertServerConfig } = await import("../src/config.js");
    expect(() => assertServerConfig()).not.toThrow();
  });
});

// AC-104 groundwork: retrievalConfig() is the snapshot serialized into every eval-run
// artifact, so it must (a) carry every knob of the retrieval pipeline, (b) equal the
// constants the pipeline ACTUALLY runs with (single source — no drift), and (c) be
// JSON-safe (wave-2's artifact writer and wave-6's bakeoff serialize it verbatim).
// Pure unit test — no DB, no network (importing memory.js creates the pg pool object
// but never connects).

import { describe, expect, it } from "vitest";
import {
  RERANK_DOC_TRUNCATION,
  SNIPPET_CHARS,
  retrievalConfig,
} from "../src/memory.js";
import { config } from "../src/config.js";

describe("retrievalConfig() snapshot (memory-mcp)", () => {
  const snap = retrievalConfig();

  it("contains every retrieval knob", () => {
    expect(Object.keys(snap).sort()).toEqual(
      [
        "service",
        "rrfK",
        "blend",
        "recencyHalfLifeDays",
        "candidatePool",
        "recallLimit",
        "embedModel",
        "contextModel",
        "rerankModel",
        "rerankDocTruncation",
        "snippetChars",
      ].sort(),
    );
    expect(Object.keys(snap.blend).sort()).toEqual([
      "importance",
      "recency",
      "relevance",
    ]);
  });

  it("matches the tuned constants and live config values", () => {
    expect(snap.service).toBe("memory-mcp");
    expect(snap.rrfK).toBe(60);
    expect(snap.blend).toEqual({
      relevance: 0.7,
      recency: 0.2,
      importance: 0.1,
    });
    expect(snap.recencyHalfLifeDays).toBe(30);
    expect(snap.recallLimit).toBe(50);
    expect(snap.candidatePool).toBe(config.candidatePool);
    expect(snap.embedModel).toBe(config.embedModel);
    expect(snap.contextModel).toBe(config.contextModel);
    expect(snap.rerankModel).toBe(config.rerankModel);
  });

  it("serializes the SAME truncation constants rerankAndBlend runs with", () => {
    expect(snap.rerankDocTruncation).toBe(RERANK_DOC_TRUNCATION);
    expect(snap.snippetChars).toBe(SNIPPET_CHARS);
    expect(RERANK_DOC_TRUNCATION).toBe(1200);
    expect(SNIPPET_CHARS).toBe(180);
  });

  it("is JSON-safe (round-trips losslessly)", () => {
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});

import type { CodeHit } from "./search.js";

interface RankedHit {
  hit: CodeHit;
  rank: number;
}

interface Survivor {
  hit: CodeHit;
  rank: number;
  mergedCount: number;
}

function chunkCount(hit: CodeHit): number {
  return hit.mergedCount ?? 1;
}

function unionRange(a: CodeHit, b: CodeHit): { startLine: number; endLine: number } {
  return {
    startLine: Math.min(a.startLine, b.startLine),
    endLine: Math.max(a.endLine, b.endLine),
  };
}

function lineSpan(range: { startLine: number; endLine: number }): number {
  return range.endLine - range.startLine + 1;
}

function overlapsOrTouches(a: CodeHit, b: CodeHit): boolean {
  return a.startLine <= b.endLine + 1 && b.startLine <= a.endLine + 1;
}

function canMerge(a: CodeHit, b: CodeHit, maxSpan: number): boolean {
  if (!overlapsOrTouches(a, b)) return false;
  return lineSpan(unionRange(a, b)) <= maxSpan;
}

function mergeIntoLeader(leader: Survivor, incoming: Survivor): Survivor {
  const range = unionRange(leader.hit, incoming.hit);
  const mergedCount = leader.mergedCount + incoming.mergedCount;
  return {
    rank: leader.rank,
    mergedCount,
    hit: {
      ...leader.hit,
      startLine: range.startLine,
      endLine: range.endLine,
      mergedCount,
    },
  };
}

export function mergeAdjacentHits(hits: CodeHit[], maxSpan: number): CodeHit[] {
  const byFile = new Map<string, RankedHit[]>();
  hits.forEach((hit, rank) => {
    const group = byFile.get(hit.filePath);
    if (group) group.push({ hit, rank });
    else byFile.set(hit.filePath, [{ hit, rank }]);
  });

  const survivors: Survivor[] = [];
  for (const group of byFile.values()) {
    const fileSurvivors: Survivor[] = [];
    for (const ranked of group.sort((a, b) => a.rank - b.rank)) {
      const incoming: Survivor = {
        hit: ranked.hit,
        rank: ranked.rank,
        mergedCount: chunkCount(ranked.hit),
      };
      let mergeIndex = fileSurvivors.findIndex((s) =>
        canMerge(s.hit, incoming.hit, maxSpan),
      );
      if (mergeIndex === -1) {
        fileSurvivors.push(incoming);
        continue;
      }

      let merged = mergeIntoLeader(fileSurvivors[mergeIndex], incoming);
      fileSurvivors[mergeIndex] = merged;
      for (let i = 0; i < fileSurvivors.length; i++) {
        if (i === mergeIndex) continue;
        if (!canMerge(merged.hit, fileSurvivors[i].hit, maxSpan)) continue;
        merged = mergeIntoLeader(merged, fileSurvivors[i]);
        fileSurvivors[mergeIndex] = merged;
        fileSurvivors.splice(i, 1);
        if (i < mergeIndex) mergeIndex--;
        i = -1;
      }
    }
    survivors.push(...fileSurvivors);
  }

  return survivors.sort((a, b) => a.rank - b.rank).map((s) => s.hit);
}

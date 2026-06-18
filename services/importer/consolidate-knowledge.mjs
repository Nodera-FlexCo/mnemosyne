#!/usr/bin/env node
// Consolidate the LATEST version of every unique knowledge doc across the Nodex
// main checkout + all 90 worktrees. Worktrees are time-snapshots of the same
// accumulating .claude/<cat> folders, so we group by canonical path
// (".claude/<cat>/<subpath>"), keep the newest-mtime copy, and stage the winners
// into a clean Nodex-shaped tree the importer can ingest (with path dedup).
//
//   node consolidate-knowledge.mjs                 # report only
//   STAGE=1 node consolidate-knowledge.mjs         # also copy winners into OUT
//
// Env: NODEX (default ~/Developer/Apps/Nodex), OUT (stage dir),
//      NAMED_ONLY=1 to skip ephemeral agent-* worktrees.

import { readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const NODEX = process.env.NODEX || join(homedir(), 'Developer/Apps/Nodex');
const OUT = process.env.OUT || join(process.env.TMPDIR || '/tmp', 'consolidated/Developer/Apps/Nodex');
const STAGE = process.env.STAGE === '1';
const NAMED_ONLY = process.env.NAMED_ONLY === '1';
const CATS = ['plans', 'research', 'tech-debt', 'reviews', 'notes'];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// roots = main checkout + each worktree
const roots = [{ name: '(main)', base: NODEX }];
const wtDir = join(NODEX, '.claude/worktrees');
if (existsSync(wtDir)) {
  for (const w of readdirSync(wtDir)) {
    if (NAMED_ONLY && /^agent-[0-9a-f]/i.test(w)) continue;
    const base = join(wtDir, w);
    if (statSync(base).isDirectory()) roots.push({ name: w, base });
  }
}

// canonicalKey -> {file, mtime, root} keeping newest mtime
const best = new Map();
const perCat = {};
let scanned = 0;
for (const cat of CATS) {
  perCat[cat] = new Set();
  for (const r of roots) {
    // a worktree itself contains .claude/worktrees/* — don't double-descend into nested worktrees
    const catDir = join(r.base, '.claude', cat);
    for (const f of walk(catDir)) {
      scanned++;
      const sub = f.split(`/.claude/${cat}/`, 2)[1];
      if (!sub) continue;
      const key = `.claude/${cat}/${sub}`;
      perCat[cat].add(key);
      let m = 0; try { m = statSync(f).mtimeMs; } catch {}
      const cur = best.get(key);
      if (!cur || m > cur.mtime) best.set(key, { file: f, mtime: m, root: r.name, cat });
    }
  }
}

console.log(`scanned ${scanned} files across ${roots.length} roots (main + ${roots.length - 1} worktrees)${NAMED_ONLY ? ' [named-only]' : ''}`);
console.log(`\n${'category'.padEnd(12)} ${'uniqueDocs'.padStart(10)}`);
let total = 0;
for (const cat of CATS) { console.log(`${cat.padEnd(12)} ${String(perCat[cat].size).padStart(10)}`); total += perCat[cat].size; }
console.log(`${'TOTAL'.padEnd(12)} ${String(total).padStart(10)} unique canonical docs (latest version each)`);

// where do winners come from? (recency of the chosen copies)
const fromMain = [...best.values()].filter((v) => v.root === '(main)').length;
console.log(`\nwinners taken from main checkout: ${fromMain}   from worktrees (newer): ${best.size - fromMain}`);

if (STAGE) {
  let staged = 0;
  for (const [key, v] of best) {
    const dest = join(OUT, key);
    mkdirSync(dirname(dest), { recursive: true });
    try { copyFileSync(v.file, dest); staged++; } catch (e) { console.error('copy fail', key, e.message); }
  }
  console.log(`\nstaged ${staged} winner files -> ${OUT}`);
}

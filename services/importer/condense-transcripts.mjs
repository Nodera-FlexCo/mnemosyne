#!/usr/bin/env node
// Condense Claude Code session transcripts (.jsonl) into compact text the Haiku
// distiller can read. Runs on the Mac (where the transcripts live). Strips the
// bulk noise — tool inputs/outputs, file dumps, thinking blocks — and keeps the
// human intent (user turns) + the assistant's prose. Writes one .txt per session
// plus a manifest.json into OUT_DIR.
//
//   node condense-transcripts.mjs            # default: Nodex projects -> ./condensed
//   OUT_DIR=/tmp/cond node condense-transcripts.mjs
//
// Then scp the OUT_DIR to the box and run distill-transcripts.mjs there.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const H = homedir();
const PROJECTS = process.env.PROJECTS_DIR || join(H, '.claude/projects');
const OUT_DIR = process.env.OUT_DIR || join(process.cwd(), 'condensed');
const ONLY = (process.env.ONLY_MATCH || 'Nodex'); // substring filter on project dir name
const MAX_CHARS = Number(process.env.MAX_CHARS || 100_000); // ~25k tokens to Haiku
const KEEP_THINKING = process.env.KEEP_THINKING === '1';

mkdirSync(OUT_DIR, { recursive: true });

function textFromContent(content) {
  // user/assistant message.content can be a string or an array of parts
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    switch (p.type) {
      case 'text': if (p.text) out.push(p.text); break;
      case 'thinking': if (KEEP_THINKING && p.thinking) out.push(`(thinking) ${p.thinking.slice(0, 600)}`); break;
      case 'tool_use': {
        const arg = p.input && (p.input.file_path || p.input.path || p.input.command || p.input.pattern || p.input.query);
        out.push(`[tool:${p.name}${arg ? ' ' + String(arg).slice(0, 120) : ''}]`);
        break;
      }
      case 'tool_result': /* drop — this is the noise we're stripping */ break;
      default: break;
    }
  }
  return out.join('\n');
}

function condenseFile(path) {
  let aiTitle = '', cwd = '', gitBranch = '', firstTs = '', lastTs = '';
  let userMsgs = 0, asstMsgs = 0;
  const turns = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.timestamp) { if (!firstTs) firstTs = d.timestamp; lastTs = d.timestamp; }
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.gitBranch && !gitBranch) gitBranch = d.gitBranch;
    if (d.type === 'ai-title' && d.aiTitle) { aiTitle = d.aiTitle; continue; }
    if (d.type === 'user') {
      const t = textFromContent(d.message?.content).trim();
      if (t && !/^\[tool:/.test(t)) { turns.push(`USER: ${t}`); userMsgs++; }
    } else if (d.type === 'assistant') {
      const t = textFromContent(d.message?.content).trim();
      if (t) { turns.push(`ASSISTANT: ${t}`); asstMsgs++; }
    }
  }
  let body = turns.join('\n\n');
  // Head+tail clamp so we keep the goal (start) and the outcome (end)
  if (body.length > MAX_CHARS) {
    const half = Math.floor(MAX_CHARS / 2);
    body = body.slice(0, half) + `\n\n...[${body.length - MAX_CHARS} chars elided]...\n\n` + body.slice(-half);
  }
  const sessionId = basename(path, '.jsonl');
  const title = (aiTitle || (turns.find((t) => t.startsWith('USER:')) || sessionId).replace(/^USER:\s*/, '')).slice(0, 200);
  const eventDate = firstTs ? firstTs.slice(0, 10) : null;
  return { sessionId, title, cwd, gitBranch, eventDate, chars: body.length, userMsgs, asstMsgs, body };
}

const manifest = [];
let projects = 0, files = 0, skipped = 0;
for (const proj of readdirSync(PROJECTS)) {
  if (ONLY && !proj.includes(ONLY)) continue;
  const dir = join(PROJECTS, proj);
  let entries; try { entries = readdirSync(dir); } catch { continue; }
  const jsonl = entries.filter((e) => e.endsWith('.jsonl'));
  if (!jsonl.length) continue;
  projects++;
  for (const f of jsonl) {
    const c = condenseFile(join(dir, f));
    if (c.userMsgs === 0 && c.asstMsgs === 0) { skipped++; continue; } // empty/system-only
    if (c.body.trim().length < 80) { skipped++; continue; }
    const outName = `${c.sessionId}.txt`;
    writeFileSync(join(OUT_DIR, outName), c.body);
    manifest.push({ file: outName, project: proj, sessionId: c.sessionId, title: c.title,
      cwd: c.cwd, gitBranch: c.gitBranch, eventDate: c.eventDate, chars: c.chars,
      userMsgs: c.userMsgs, asstMsgs: c.asstMsgs });
    files++;
  }
}
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
const totalChars = manifest.reduce((a, m) => a + m.chars, 0);
console.log(`condensed ${files} transcripts from ${projects} projects (${skipped} skipped) -> ${OUT_DIR}`);
console.log(`  total ${Math.round(totalChars / 1000)}k chars (~${Math.round(totalChars / 4000)}k Haiku input tokens)`);
console.log(`  manifest: ${join(OUT_DIR, 'manifest.json')}`);
for (const m of manifest.slice(0, 12)) console.log(`   ${String(m.chars).padStart(7)}c  ${m.eventDate || '----------'}  ${m.title.slice(0, 70)}`);

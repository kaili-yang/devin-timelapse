'use strict';
// Session -> timelapse timeline: a list of events placed on a short video clock, with
// running counters. Pure (no I/O), so the player can render any frame deterministically.

const path = require('node:path');

const INTRO = 2.5;
const OUTRO = 3.5;
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'notebook_edit', 'multi_edit']);
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'find_file_by_name', 'code_search', 'notebook_read']);
const SHELL_TOOLS = new Set(['exec']);
const QUIET_TOOLS = new Set(['get_output', 'write_to_process', 'kill_shell', 'read_subagent', 'mcp_list_tools', 'mcp_list_servers']);
const TEMP_DIR_RE = /^(\/private)?\/(tmp|var\/folders)\/|[\\/]Temp[\\/]/i;

function clip(s, n) {
  const a = [...String(s || '').replace(/\s+/g, ' ').trim()];
  return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join('');
}

/** Hides words but keeps the shape: "npm test" -> "npm ••••", code -> "•••• = •••;" */
function redactText(s) {
  return String(s).replace(/[\p{L}\p{N}_]/gu, '•');
}

function redactFile(p) {
  const ext = path.extname(p);
  return `${'•'.repeat(Math.min(8, Math.max(3, path.basename(p, ext).length)))}${ext}`;
}

function toolKind(name) {
  if (SHELL_TOOLS.has(name)) return 'exec';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (READ_TOOLS.has(name)) return 'read';
  if (name === 'web_search' || name === 'webfetch' || /browser|chrome|navigate|playwright/i.test(name)) return 'web';
  if (name === 'todo_write') return 'plan';
  if (name === 'ask_user_question') return 'ask';
  if (name === 'run_subagent') return 'delegate';
  return 'tool';
}

function targetOf(args) {
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof args[k] === 'string') return path.basename(args[k]);
  if (typeof args.url === 'string') {
    try { return new URL(args.url).host + new URL(args.url).pathname.replace(/\/$/, ''); } catch { return args.url; }
  }
  for (const k of ['query', 'pattern', 'search_term', 'title', 'tool_name', 'skill', 'task']) if (typeof args[k] === 'string') return args[k];
  return '';
}

/** Ordered diff lines: removed first, then new text with added lines marked (multiset, no LCS). */
function diffLines(oldText, newText, max = 18) {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const pool = new Map();
  for (const l of oldLines) pool.set(l, (pool.get(l) || 0) + 1);
  const marked = newLines.map((l) => {
    const c = pool.get(l) || 0;
    if (c > 0) { pool.set(l, c - 1); return { op: ' ', text: l }; }
    return { op: '+', text: l };
  });
  const removed = [];
  for (const [l, c] of pool) for (let i = 0; i < c; i++) removed.push({ op: '-', text: l });
  const added = marked.filter((m) => m.op === '+').length;
  // show the region around the first change, with removed lines just before it
  const first = Math.max(0, marked.findIndex((m) => m.op === '+'));
  const start = Math.max(0, first - 2);
  const lines = [...removed.slice(0, 4), ...marked.slice(start, start + max)].slice(0, max);
  return { lines, added, removed: removed.length };
}

function outputTail(content, n = 8) {
  const body = String(content || '').replace(/^Output from command in shell \S+:\n?/, '').replace(/\n*Exit code: -?\d+\s*$/, '');
  return body.split('\n').filter((l) => l.trim() !== '').slice(-n).map((l) => clip(l, 110));
}

function exitCode(content) {
  const m = /Exit code: (-?\d+)\s*$/.exec(String(content || ''));
  return m ? Number(m[1]) : null;
}

/** Raw events in real time, before placement on the video clock. */
function extractEvents(session, { redact = false } = {}) {
  const results = new Map();
  for (const m of session.messages) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m.content);
  const R = (s) => (redact ? redactText(s) : s);
  const RF = (s) => (redact ? redactFile(s) : s);
  const events = [];
  for (const m of session.messages) {
    if (m.role === 'user') {
      events.push({ ts: m.ts, kind: 'prompt', text: clip(R(m.content), 280) });
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (m.content.trim()) events.push({ ts: m.ts, kind: 'say', text: clip(R(m.content), 220) });
    for (const c of m.toolCalls) {
      if (QUIET_TOOLS.has(c.name)) continue;
      const kind = toolKind(c.name);
      const a = c.arguments;
      const ev = { ts: m.ts, kind, tool: c.name };
      if (kind === 'exec') {
        const cmd = String(a.command || '').split('\n')[0];
        const out = results.get(c.id);
        ev.command = clip(redact ? cmd.replace(/^(\S+)(.*)$/, (_, p, rest) => p + redactText(rest)) : cmd, 120);
        ev.output = outputTail(out).map(R);
        const code = exitCode(out);
        ev.error = code != null && code !== 0;
      } else if (kind === 'edit') {
        const d = (session.diffs.get(c.id) || [])[0];
        const file = d ? d.path : String(a.file_path || a.path || '');
        const diff = d
          ? diffLines(d.oldText, d.newText)
          : diffLines(typeof a.old_string === 'string' ? a.old_string : '', typeof a.new_string === 'string' ? a.new_string : typeof a.content === 'string' ? a.content : '');
        ev.file = RF(path.basename(file) || c.name);
        ev.path = file;
        ev.lines = diff.lines.map((l) => ({ op: l.op, text: clip(R(l.text), 110) }));
        ev.added = diff.added;
        ev.removed = diff.removed;
      } else if (kind === 'plan') {
        const todos = Array.isArray(a.todos) ? a.todos : [];
        ev.items = todos.slice(0, 6).map((t) => ({ text: clip(R(t.content || ''), 70), done: t.status === 'completed', active: t.status === 'in_progress' }));
        ev.target = `${todos.filter((t) => t.status === 'completed').length}/${todos.length}`;
      } else {
        const tgt = targetOf(a);
        ev.target = clip(kind === 'read' && /\.\w+$/.test(tgt) ? RF(tgt) : R(tgt), 90);
      }
      events.push(ev);
    }
  }
  return events.sort((x, y) => x.ts - y.ts);
}

const PRIORITY = { prompt: 0, edit: 1, exec: 2, plan: 3, ask: 3, delegate: 3, web: 4, say: 5, read: 6, tool: 7 };

/**
 * @param {object} session from loadSession
 * @param {{ seconds?: number, redact?: boolean }} opts
 */
function buildTimeline(session, { seconds, redact = false } = {}) {
  const raw = extractEvents(session, { redact });
  const n = raw.length;
  const duration = seconds || Math.min(30, Math.max(12, Math.round(n * 1.1 + INTRO + OUTRO)));
  const span = duration - INTRO - OUTRO;
  const ts0 = n ? raw[0].ts : 0;
  const ts1 = n ? raw[n - 1].ts : 0;
  const real = ts1 - ts0;
  // Mostly evenly spaced (so bursts stay readable) with a bit of real time (so long pauses show).
  raw.forEach((e, i) => {
    const even = n > 1 ? i / (n - 1) : 0;
    const timeFrac = real > 0 ? (e.ts - ts0) / real : even;
    e.t = +(INTRO + span * (0.75 * even + 0.25 * timeFrac)).toFixed(3);
  });
  // Only ~2.2 events per second get the main stage; prompts, edits and commands first.
  const budget = Math.max(6, Math.floor(span * 2.2));
  let featured = raw;
  if (n > budget) {
    // Fill the budget class by class (prompts, edits, commands, …); when a class does not fit,
    // take an evenly spaced subset so the whole session stays represented.
    const keep = new Set();
    const classes = [...new Set(Object.values(PRIORITY))].sort((a, b) => a - b);
    for (const p of classes) {
      const idx = [...raw.keys()].filter((i) => PRIORITY[raw[i].kind] === p);
      const room = budget - keep.size;
      if (room <= 0) break;
      if (idx.length <= room) idx.forEach((i) => keep.add(i));
      else for (let k = 0; k < room; k++) keep.add(idx[Math.floor(((k + 0.5) * idx.length) / room)]);
    }
    featured = raw.filter((_, i) => keep.has(i));
  }
  featured.forEach((e) => { e.featured = true; });

  const files = new Set();
  const counters = { tools: 0, files: 0, added: 0, removed: 0, commands: 0, errors: 0, prompts: 0 };
  for (const e of raw) {
    if (e.kind === 'prompt') counters.prompts++;
    else if (e.kind !== 'say') counters.tools++;
    if (e.kind === 'exec') { counters.commands++; if (e.error) counters.errors++; }
    if (e.kind === 'edit') {
      files.add(e.path || e.file);
      counters.added += e.added;
      counters.removed += e.removed;
    }
    counters.files = files.size;
    e.c = { ...counters };
    delete e.path;
  }

  const project = session.cwd && !TEMP_DIR_RE.test(session.cwd) ? path.basename(session.cwd) : '';
  return {
    version: 1,
    meta: {
      title: redact ? redactText(session.title) : session.title,
      project: redact ? '' : project,
      start: ts0,
      end: ts1,
      realMs: real,
    },
    duration,
    intro: INTRO,
    outro: OUTRO,
    totals: { ...counters },
    events: raw,
  };
}

module.exports = { INTRO, OUTRO, clip, redactText, redactFile, toolKind, diffLines, outputTail, exitCode, extractEvents, buildTimeline };

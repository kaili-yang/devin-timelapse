'use strict';
// Reads one session (messages + file diffs) from Devin's local session store, read-only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultDbPath(env = process.env) {
  if (env.DEVIN_SESSIONS_DB) return env.DEVIN_SESSIONS_DB;
  const base = process.platform === 'win32' && env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'devin')
    : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'devin');
  return path.join(base, 'cli', 'sessions.db');
}

function openDb(file) {
  if (!fs.existsSync(file)) throw new Error(`no Devin session store at ${file} (use --db <path>)`);
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

function parse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * The row's created_at is rewritten when Devin compacts or reloads a session (many rows share one
 * value); the message's own metadata.created_at keeps the real time, so prefer it.
 */
function messageTime(m, rowCreatedAt) {
  const iso = m && m.metadata && m.metadata.created_at;
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : rowCreatedAt * 1000;
}

function listSessions(file, limit = 15) {
  const db = openDb(file);
  try {
    return db.prepare(`SELECT s.id, s.title, s.working_directory AS cwd, s.created_at, s.last_activity_at, COUNT(m.row_id) AS messages
      FROM sessions s JOIN message_nodes m ON m.session_id = s.id
      WHERE s.hidden = 0 GROUP BY s.id ORDER BY s.last_activity_at DESC LIMIT ?`).all(limit)
      .map((r) => ({ id: r.id, title: r.title || '', cwd: r.cwd || '', createdAt: r.created_at * 1000, lastActivityAt: r.last_activity_at * 1000, messages: Number(r.messages) }));
  } finally {
    db.close();
  }
}

/**
 * @returns {{ id, title, cwd, model, messages: Array<{ role, ts, content, userInput, toolCalls, toolCallId }>, diffs: Map<string, Array<{ path, oldText, newText }>> }}
 */
function loadSession(file, id) {
  const db = openDb(file);
  try {
    const s = db.prepare('SELECT id, title, working_directory AS cwd, model FROM sessions WHERE id = ?').get(id);
    if (!s) throw new Error(`no session "${id}" (see --list)`);
    const seen = new Set();
    const messages = [];
    for (const row of db.prepare('SELECT chat_message, created_at FROM message_nodes WHERE session_id = ? ORDER BY row_id').iterate(id)) {
      const m = parse(row.chat_message);
      if (!m || !['user', 'assistant', 'tool'].includes(m.role)) continue;
      if (m.message_id) {
        if (seen.has(m.message_id)) continue;
        seen.add(m.message_id);
      }
      const content = typeof m.content === 'string' ? m.content : '';
      const userInput = m.role === 'user' && !!(m.metadata && m.metadata.is_user_input) && !/^Output a summary from the following messages/.test(content);
      if (m.role === 'user' && !userInput) continue;
      messages.push({
        role: m.role,
        ts: messageTime(m, row.created_at),
        content,
        userInput,
        toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => ({ id: c.id, name: String(c.name || ''), arguments: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} })) : [],
        toolCallId: m.tool_call_id,
      });
    }
    const diffs = new Map();
    for (const row of db.prepare("SELECT tool_call_id, tool_call_json FROM tool_call_state WHERE session_id = ? AND tool_call_json LIKE '%\"diff\"%'").iterate(id)) {
      const call = parse(row.tool_call_json);
      const list = (call && Array.isArray(call.content) ? call.content : [])
        .filter((c) => c && c.type === 'diff' && typeof c.path === 'string')
        .map((c) => ({ path: c.path, oldText: typeof c.oldText === 'string' ? c.oldText : '', newText: typeof c.newText === 'string' ? c.newText : '' }));
      if (list.length) diffs.set(row.tool_call_id, list);
    }
    return { id: s.id, title: s.title || s.id, cwd: s.cwd || '', model: s.model || '', messages, diffs };
  } finally {
    db.close();
  }
}

module.exports = { defaultDbPath, messageTime, listSessions, loadSession };

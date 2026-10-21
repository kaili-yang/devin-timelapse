'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);

function buildStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-timelapse-test-'));
  const file = path.join(dir, 'sessions.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER,
      chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT);
    CREATE TABLE tool_call_state (session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_call_json TEXT, tool_call_update_json TEXT, source_node_ids TEXT,
      PRIMARY KEY (session_id, tool_call_id));`);
  db.prepare("INSERT INTO sessions VALUES ('s1', '/Users/me/src/shop', 'windsurf', 'm', 'x', ?, ?, 'Fix checkout bug', 0, NULL)").run(T0 / 1000, T0 / 1000 + 3600);
  db.prepare("INSERT INTO sessions VALUES ('empty', '/tmp/x', 'windsurf', 'm', 'x', ?, ?, 'Nothing', 0, NULL)").run(T0 / 1000, T0 / 1000);
  let node = 0;
  // the row created_at is the same coarse value for every row, as after a compaction; metadata has the real time
  const put = (m, minutes) => db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)')
    .run('s1', node++, JSON.stringify({ ...m, metadata: { ...(m.metadata || {}), created_at: new Date(T0 + minutes * 60000).toISOString() } }), T0 / 1000);
  put({ message_id: 'u1', role: 'user', content: 'The checkout total is wrong </script> please fix', metadata: { is_user_input: true } }, 0);
  put({ message_id: 'a1', role: 'assistant', content: 'Let me look at the cart code.', tool_calls: [
    { id: 'c1', name: 'read', arguments: { file_path: '/Users/me/src/shop/cart.ts' } },
    { id: 'c2', name: 'exec', arguments: { command: 'npm test -- cart\necho second line' } },
  ] }, 1);
  put({ message_id: 't2', role: 'tool', tool_call_id: 'c2', content: 'Output from command in shell abc:\n FAIL cart.test.ts\n  expected 30 got 33\n\n\nExit code: 1' }, 2);
  put({ message_id: 'a2', role: 'assistant', content: '', tool_calls: [{ id: 'c3', name: 'edit', arguments: { file_path: '/Users/me/src/shop/cart.ts', old_string: 'x', new_string: 'y' } }] }, 3);
  put({ message_id: 'a2', role: 'assistant', content: '', tool_calls: [] }, 3); // duplicate branch copy
  put({ message_id: 'a3', role: 'assistant', content: '', tool_calls: [
    { id: 'c4', name: 'get_output', arguments: {} },
    { id: 'c5', name: 'todo_write', arguments: { todos: [{ content: 'fix tax', status: 'completed' }, { content: 'add test', status: 'in_progress' }] } },
    { id: 'c6', name: 'web_search', arguments: { query: 'rounding money in js' } },
  ] }, 40);
  put({ message_id: 'u2', role: 'user', content: 'Output a summary from the following messages: ...', metadata: { is_user_input: true } }, 41);
  put({ message_id: 'a4', role: 'assistant', content: 'Fixed: totals now round per line.', tool_calls: [] }, 60);
  db.prepare('INSERT INTO tool_call_state (session_id, tool_call_id, tool_call_json) VALUES (?, ?, ?)')
    .run('s1', 'c3', JSON.stringify({ kind: 'edit', content: [{ type: 'diff', path: '/Users/me/src/shop/cart.ts', oldText: 'const a = 1;\nconst total = sum * tax;\nexport {};', newText: 'const a = 1;\nconst total = round(sum * tax);\nconst x = 2;\nexport {};' }] }));
  db.close();
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { buildStore, T0 };

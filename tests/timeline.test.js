'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStore, T0 } = require('./fixture');
const { loadSession, listSessions, messageTime } = require('../lib/store');
const { buildTimeline, extractEvents, diffLines, outputTail, exitCode, redactText, redactFile, INTRO, OUTRO } = require('../lib/timeline');
const { buildHtml, inlineJson } = require('../lib/html');
const { MessageSplitter } = require('../lib/cdp');
const { ffmpegArgs } = require('../lib/video');

test('loadSession: real message times, deduped, no compaction prompts', (t) => {
  const s = buildStore();
  t.after(s.cleanup);
  const session = loadSession(s.file, 's1');
  assert.equal(session.title, 'Fix checkout bug');
  assert.deepEqual(session.messages.map((m) => m.role).join(','), 'user,assistant,tool,assistant,assistant,assistant');
  assert.equal(session.messages[0].ts, T0);
  assert.equal(session.messages.at(-1).ts, T0 + 60 * 60000);
  assert.equal(session.diffs.get('c3')[0].path, '/Users/me/src/shop/cart.ts');
  assert.deepEqual(listSessions(s.file).map((x) => x.id), ['s1']);
  assert.throws(() => loadSession(s.file, 'nope'), /no session/);
  assert.equal(messageTime({ metadata: { created_at: 'garbage' } }, 5), 5000);
});

test('events: kinds, command output, exit codes, diffs, quiet tools skipped', (t) => {
  const s = buildStore();
  t.after(s.cleanup);
  const ev = extractEvents(loadSession(s.file, 's1'));
  assert.deepEqual(ev.map((e) => e.kind), ['prompt', 'say', 'read', 'exec', 'edit', 'plan', 'web', 'say']);
  const exec = ev.find((e) => e.kind === 'exec');
  assert.equal(exec.command, 'npm test -- cart');
  assert.deepEqual(exec.output, ['FAIL cart.test.ts', 'expected 30 got 33']);
  assert.equal(exec.error, true);
  const edit = ev.find((e) => e.kind === 'edit');
  assert.equal(edit.file, 'cart.ts');
  assert.equal(edit.added, 2);
  assert.equal(edit.removed, 1);
  assert.deepEqual(edit.lines.map((l) => l.op), ['-', ' ', '+', '+', ' ']);
  assert.equal(ev.find((e) => e.kind === 'read').target, 'cart.ts');
  assert.equal(ev.find((e) => e.kind === 'web').target, 'rounding money in js');
  assert.deepEqual(ev.find((e) => e.kind === 'plan').items.map((i) => [i.done, i.active]), [[true, false], [false, true]]);
});

test('timeline: placement on the video clock and running counters', (t) => {
  const s = buildStore();
  t.after(s.cleanup);
  const tl = buildTimeline(loadSession(s.file, 's1'), { seconds: 20 });
  assert.equal(tl.duration, 20);
  assert.equal(tl.meta.project, 'shop');
  assert.equal(tl.meta.realMs, 60 * 60000);
  const ts = tl.events.map((e) => e.t);
  assert.equal(ts[0], INTRO);
  assert.equal(ts.at(-1), 20 - OUTRO);
  assert.deepEqual([...ts].sort((a, b) => a - b), ts, 'monotonic');
  assert.ok(tl.events.every((e) => e.featured));
  assert.deepEqual(tl.totals, { tools: 5, files: 1, added: 2, removed: 1, commands: 1, errors: 1, prompts: 1 });
  assert.equal(tl.events.find((e) => e.kind === 'edit').c.files, 1);
  assert.equal(tl.events[0].c.tools, 0);
  // default length adapts to the amount of activity
  assert.ok(buildTimeline(loadSession(s.file, 's1')).duration >= 12);
});

test('long sessions feature a subset, spread across the session, prompts first', () => {
  const messages = [];
  for (let i = 0; i < 400; i++) {
    messages.push({ role: 'assistant', ts: i * 1000, content: '', toolCalls: [{ id: `r${i}`, name: i % 2 ? 'read' : 'exec', arguments: { command: `cmd${i}`, file_path: `/f${i}.ts` } }] });
    if (i % 100 === 0) messages.push({ role: 'user', ts: i * 1000 + 1, content: `prompt ${i}`, userInput: true, toolCalls: [] });
  }
  const tl = buildTimeline({ title: 'big', cwd: '', messages, diffs: new Map() }, { seconds: 30 });
  const featured = tl.events.filter((e) => e.featured);
  assert.ok(featured.length <= Math.floor((30 - INTRO - OUTRO) * 2.2));
  assert.equal(featured.filter((e) => e.kind === 'prompt').length, 4);
  const execs = featured.filter((e) => e.kind === 'exec');
  assert.ok(execs.length > 10);
  assert.ok(execs.at(-1).ts > 300_000, 'commands from the end of the session are featured too');
  assert.equal(tl.totals.commands, 200, 'counters still count everything');
});

test('redaction hides text but keeps shape, program names and extensions', (t) => {
  const s = buildStore();
  t.after(s.cleanup);
  const tl = buildTimeline(loadSession(s.file, 's1'), { redact: true });
  const json = JSON.stringify(tl);
  for (const secret of ['checkout', 'cart.ts', 'rounding', 'tax', 'shop']) assert.ok(!json.includes(secret), secret);
  assert.equal(tl.events.find((e) => e.kind === 'exec').command, 'npm •••• -- ••••');
  assert.match(tl.events.find((e) => e.kind === 'edit').file, /^•+\.ts$/);
  assert.equal(redactText('a = 1;'), '• = •;');
  assert.equal(redactFile('/x/secret-plan.md'), '••••••••.md');
});

test('helpers', () => {
  assert.deepEqual(diffLines('', 'a\nb').lines.map((l) => l.op), ['+', '+']);
  assert.equal(diffLines('a\nb\nc', 'a\nc').removed, 1);
  assert.deepEqual(outputTail('Output from command in shell x:\nok\n\nExit code: 0'), ['ok']);
  assert.equal(exitCode('...\nExit code: 2'), 2);
  assert.equal(exitCode('no code'), null);
});

test('HTML inlines data safely and works offline', (t) => {
  const s = buildStore();
  t.after(s.cleanup);
  const html = buildHtml(buildTimeline(loadSession(s.file, 's1')));
  assert.equal((html.match(/<\/script>/g) || []).length, 2, 'the prompt containing </script> must not end the data block');
  assert.ok(!/src=["']https?:/.test(html), 'no external resources');
  assert.match(html, /lang="en"/);
  assert.equal(inlineJson({ a: '</script>\u2028' }), '{"a":"\\u003c/script>\\u2028"}');
});

test('CDP pipe messages are split on NUL bytes across chunks', () => {
  const got = [];
  const sp = new MessageSplitter((m) => got.push(m));
  sp.push(Buffer.from('{"id":1}\0{"id"'));
  sp.push(Buffer.from(':2}\0'));
  sp.push(Buffer.from('{"id":3}'));
  assert.deepEqual(got, ['{"id":1}', '{"id":2}']);
  sp.push(Buffer.from('\0'));
  assert.deepEqual(got.at(-1), '{"id":3}');
});

test('ffmpeg arguments for mp4 and gif', () => {
  assert.ok(ffmpegArgs('/o.mp4', 30).includes('libx264'));
  assert.ok(ffmpegArgs('/o.GIF', 30).some((a) => a.includes('palettegen')));
});

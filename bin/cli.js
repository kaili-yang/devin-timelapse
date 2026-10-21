#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { defaultDbPath, listSessions, loadSession } = require('../lib/store');
const { buildTimeline } = require('../lib/timeline');
const { buildHtml } = require('../lib/html');
const { findBrowser } = require('../lib/cdp');
const { hasFfmpeg, renderVideo } = require('../lib/video');

const HELP = `devin-timelapse — turn a Devin session into a 30-second timelapse

Usage: npx devin-timelapse [session-id] [options]

  (no id)           the most recent session
  --list            recent sessions with their ids
  --seconds <n>     video length (default: 12–30 s depending on the session)
  --out <file>      .mp4 (default), .gif, or .html
  --fps <n>         frames per second for video (default 30)
  --redact          hide prompt text, code, file names and command arguments
  --db <path>       Devin session store (default: ${defaultDbPath()})
  --no-open         do not open the result
  -h, --help

Video needs ffmpeg and Chrome / Chromium / Edge (or CHROME_PATH). Without them you still get
the HTML player. Everything runs locally.`;

function openFile(file) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  spawnSync(cmd, args, { stdio: 'ignore', timeout: 10000 });
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      list: { type: 'boolean' }, seconds: { type: 'string' }, out: { type: 'string' }, fps: { type: 'string', default: '30' },
      redact: { type: 'boolean' }, db: { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(HELP);
  const db = values.db || defaultDbPath();

  if (values.list) {
    for (const s of listSessions(db, 20)) console.log(`${s.id.padEnd(24)} ${ago(s.lastActivityAt).padStart(8)}  ${String(s.messages).padStart(5)} msgs  ${s.title}`);
    return;
  }
  const id = positionals[0] || (listSessions(db, 1)[0] || {}).id;
  if (!id) throw new Error('no Devin sessions found');
  const seconds = values.seconds ? Number(values.seconds) : undefined;
  if (seconds !== undefined && !(seconds >= 8 && seconds <= 300)) throw new Error('--seconds must be between 8 and 300');
  const fps = Number(values.fps);
  if (!(fps >= 5 && fps <= 60)) throw new Error('--fps must be between 5 and 60');

  const session = loadSession(db, id);
  const timeline = buildTimeline(session, { seconds, redact: !!values.redact });
  if (!timeline.events.length) throw new Error(`session ${id} has no recorded activity`);
  console.log(`${session.title} — ${timeline.events.length} events → ${timeline.duration}s`);

  const out = path.resolve(values.out || `devin-timelapse-${id}.mp4`);
  const htmlPath = out.toLowerCase().endsWith('.html') ? out : out.replace(/\.(mp4|gif)$/i, '') + '.html';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(htmlPath, buildHtml(timeline));
  let result = htmlPath;
  if (!out.toLowerCase().endsWith('.html')) {
    const browser = findBrowser();
    if (!browser || !hasFfmpeg()) {
      console.log(`  video skipped: needs ${!browser ? 'Chrome/Chromium/Edge (or CHROME_PATH)' : ''}${!browser && !hasFfmpeg() ? ' and ' : ''}${!hasFfmpeg() ? 'ffmpeg' : ''}`);
    } else {
      const t0 = Date.now();
      await renderVideo(timeline, {
        out, fps, browser,
        onProgress: (done, total) => { if (process.stdout.isTTY && (done % 15 === 0 || done === total)) process.stdout.write(`\r  rendering ${done}/${total} frames`); },
      });
      if (process.stdout.isTTY) process.stdout.write('\n');
      console.log(`  encoded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      result = out;
    }
  }
  console.log(`  ${result}`);
  if (!values.redact) console.log('  note: the video shows your prompts, code and commands; use --redact before sharing publicly');
  if (!values['no-open']) openFile(result);
}

main().catch((e) => {
  process.stderr.write(`devin-timelapse: ${e.message}\n`);
  process.exit(1);
});

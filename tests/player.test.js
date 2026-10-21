'use strict';
// Runs the browser player in a VM with a recording fake canvas, so drawing bugs (exceptions,
// NaN coordinates) are caught without a browser. A real browser export runs when available.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildStore } = require('./fixture');
const { loadSession } = require('../lib/store');
const { buildTimeline } = require('../lib/timeline');
const { findBrowser } = require('../lib/cdp');
const { hasFfmpeg, renderVideo } = require('../lib/video');

function fakeContext(log) {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (s) => ({ width: [...String(s)].length * 9 });
      if (prop === 'createLinearGradient') return () => gradient;
      return (...args) => {
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) log.bad.push(`${String(prop)}(${args.join(',')})`);
        if (prop === 'fillText') log.text.push(String(args[0]));
      };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

function loadPlayer(timeline) {
  const log = { bad: [], text: [] };
  const ctx = fakeContext(log);
  const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/jpeg;base64,AA==' };
  const window = { TIMELAPSE: timeline, TIMELAPSE_EXPORT: true };
  const sandbox = { window, document: { getElementById: () => canvas }, performance: { now: () => 0 }, requestAnimationFrame: () => {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'player.js'), 'utf8'), sandbox);
  return { window, log };
}

test('every frame renders without exceptions or non-finite coordinates', (t) => {
  const s = buildStore();
  t.after(s.cleanup);
  const timeline = buildTimeline(loadSession(s.file, 's1'), { seconds: 16 });
  {
    const { window, log } = loadPlayer(timeline);
    assert.equal(window.__ready, true);
    for (let f = 0; f <= 16 * 10; f++) {
      log.text.length = 0;
      assert.match(window.renderFrame(f / 10), /^data:image\/jpeg/);
    }
    assert.deepEqual(log.bad, []);
  }
});

test('frames show the intro, the command and the summary at the right times', (t) => {
  const s = buildStore();
  t.after(s.cleanup);
  const timeline = buildTimeline(loadSession(s.file, 's1'), { seconds: 16 });
  const { window, log } = loadPlayer(timeline);
  const at = (sec) => { log.text.length = 0; window.renderFrame(sec); return log.text.join(' | '); };
  assert.match(at(0.5), /DEVIN TIMELAPSE.*Fix checkout bug/);
  assert.match(at(0.5), /1h 0m of work in 16 seconds/);
  const exec = timeline.events.find((e) => e.kind === 'exec');
  assert.match(at(exec.t + 0.01), /Command/);
  assert.match(at(15.9), /In this session Devin made/);
});

test('real export: headless browser + ffmpeg produce an mp4', { skip: (!findBrowser() || !hasFfmpeg()) && 'needs Chrome and ffmpeg' }, async (t) => {
  const s = buildStore();
  t.after(s.cleanup);
  const out = path.join(s.dir, 'out.mp4');
  const timeline = buildTimeline(loadSession(s.file, 's1'), { seconds: 8 });
  let frames = 0;
  await renderVideo(timeline, { out, fps: 6, browser: findBrowser(), onProgress: (d) => { frames = d; } });
  assert.equal(frames, 48);
  const head = fs.readFileSync(out).subarray(4, 8).toString('ascii');
  assert.equal(head, 'ftyp');
  assert.ok(fs.statSync(out).size > 5000);
});

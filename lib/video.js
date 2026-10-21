'use strict';
// MP4 / GIF export: a headless browser renders each frame with the same player code,
// ffmpeg encodes the JPEG stream.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Cdp } = require('./cdp');
const { buildHtml } = require('./html');

function hasFfmpeg(bin = 'ffmpeg') {
  return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
}

function ffmpegArgs(out, fps) {
  const input = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-'];
  if (out.toLowerCase().endsWith('.gif')) {
    return [...input, '-vf', 'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer', out];
  }
  return [...input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', out];
}

/**
 * @param {object} timeline
 * @param {{ out: string, fps?: number, browser: string, ffmpeg?: string, onProgress?: (done, total) => void }} opts
 */
async function renderVideo(timeline, { out, fps = 30, browser, ffmpeg = 'ffmpeg', onProgress = () => {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-timelapse-'));
  const page = path.join(tmp, 'export.html');
  fs.writeFileSync(page, buildHtml(timeline, { exportMode: true }));
  const cdp = await Cdp.launch(browser, [`--user-data-dir=${path.join(tmp, 'profile')}`]);
  const enc = spawn(ffmpeg, ffmpegArgs(out, fps), { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  enc.stderr.on('data', (d) => { stderr += d; });
  const encoded = new Promise((resolve, reject) => {
    enc.on('error', reject);
    enc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.trim() || `exit ${code}`}`))));
  });
  try {
    const evaluate = await cdp.openPage(pathToFileURL(page).href);
    const total = Math.round(timeline.duration * fps);
    for (let i = 0; i < total; i++) {
      const url = await evaluate(`window.renderFrame(${(i / fps).toFixed(4)}, 0.9)`);
      const jpg = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
      if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r));
      onProgress(i + 1, total);
    }
    enc.stdin.end();
    await encoded;
  } catch (e) {
    enc.kill();
    throw e;
  } finally {
    await cdp.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

module.exports = { hasFfmpeg, ffmpegArgs, renderVideo };

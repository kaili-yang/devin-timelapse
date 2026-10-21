'use strict';
// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe (fd 3 in, fd 4 out,
// NUL-delimited JSON). No WebSocket library needed.

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const BROWSERS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'],
  win32: [`${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`],
};

function findBrowser(env = process.env) {
  if (env.CHROME_PATH && fs.existsSync(env.CHROME_PATH)) return env.CHROME_PATH;
  return (BROWSERS[process.platform] || []).find((p) => fs.existsSync(p)) || null;
}

/** Splits a byte stream into NUL-terminated messages. */
class MessageSplitter {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.chunks = [];
  }

  push(buf) {
    let start = 0;
    for (let i = buf.indexOf(0); i !== -1; i = buf.indexOf(0, start)) {
      this.chunks.push(buf.subarray(start, i));
      this.onMessage(Buffer.concat(this.chunks).toString('utf8'));
      this.chunks = [];
      start = i + 1;
    }
    if (start < buf.length) this.chunks.push(buf.subarray(start));
  }
}

class Cdp {
  static async launch(browser, extraArgs = []) {
    const proc = spawn(browser, ['--headless=new', '--remote-debugging-pipe', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', ...extraArgs, 'about:blank'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    return new Cdp(proc);
  }

  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.exited = new Promise((resolve) => proc.on('exit', resolve));
    const splitter = new MessageSplitter((msg) => this.onMessage(msg));
    proc.stdio[4].on('data', (b) => splitter.push(b));
    proc.on('exit', () => {
      for (const { reject } of this.pending.values()) reject(new Error('browser exited'));
      this.pending.clear();
    });
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.id || !this.pending.has(msg.id)) return;
    const { resolve, reject } = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else resolve(msg.result);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdio[3].write(payload + '\0');
    });
  }

  /** Opens a page and returns a function that evaluates JS in it. */
  async openPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    const evaluate = async (expression) => {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };
    for (let i = 0; i < 200; i++) {
      try { if (await evaluate('window.__ready === true')) return evaluate; } catch { /* page still loading */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the timelapse page did not load');
  }

  async close() {
    try { await Promise.race([this.send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* already gone */ }
    if (this.proc.exitCode === null) this.proc.kill();
    await this.exited;
  }
}

module.exports = { findBrowser, MessageSplitter, Cdp };

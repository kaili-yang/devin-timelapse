'use strict';
// Devin Timelapse player. renderFrame(t) is a pure function of the timeline and t, so the same
// code drives the interactive page and the frame-by-frame MP4 export.

(function () {
  const W = 1280;
  const H = 720;
  const TL = window.TIMELAPSE;
  const ZH = (TL.lang || '').startsWith('zh');
  const SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", "Segoe UI", sans-serif';
  const MONO = '"SF Mono", Menlo, Consolas, "PingFang SC", "Noto Sans Mono CJK SC", monospace';
  const C = { bg1: '#0b1020', bg2: '#1c1040', panel: '#121729', panel2: '#0d1117', line: '#262b45', text: '#eef0ff', dim: '#8f93b8', teal: '#2ee6c5', violet: '#a77bff', pink: '#ff6bb5', yellow: '#ffd166', red: '#ff5d73', green: '#3fb950' };
  const KIND = {
    prompt: { color: '#ffffff', label: ZH ? '你的指令' : 'You asked' },
    say: { color: C.violet, label: ZH ? 'Devin 说' : 'Devin says' },
    exec: { color: C.teal, label: ZH ? '跑命令' : 'Command' },
    edit: { color: C.pink, label: ZH ? '改代码' : 'Edit' },
    read: { color: '#7aa2ff', label: ZH ? '读代码' : 'Read' },
    web: { color: C.yellow, label: ZH ? '查资料' : 'Web' },
    plan: { color: C.violet, label: ZH ? '做计划' : 'Plan' },
    ask: { color: C.yellow, label: ZH ? '提问' : 'Question' },
    delegate: { color: C.violet, label: ZH ? '派活' : 'Subagent' },
    tool: { color: C.dim, label: ZH ? '工具' : 'Tool' },
  };
  const L = ZH
    ? { tools: '次工具调用', files: '个文件', lines: '行改动', commands: '条命令', of: (a, b) => `${a} 的工作，压缩成 ${b} 秒`, summary: '这一次 Devin 一共', footer: '用 devin-timelapse 生成 · npx github:kaili-yang/devin-timelapse', activity: '动态', errors: '次报错' }
    : { tools: 'tool calls', files: 'files', lines: 'lines changed', commands: 'commands', of: (a, b) => `${a} of work in ${b} seconds`, summary: 'In this session Devin made', footer: 'made with devin-timelapse · npx github:kaili-yang/devin-timelapse', activity: 'Activity', errors: 'errors' };

  const events = TL.events;
  const featured = events.filter((e) => e.featured);

  // ---------- helpers ----------
  let g;
  const font = (size, weight = 400, mono = false) => { g.font = `${weight} ${size}px ${mono ? MONO : SANS}`; };
  function rect(x, y, w, h, fill, r = 0) {
    g.fillStyle = fill;
    g.beginPath();
    if (r && g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
    g.fill();
  }
  function text(s, x, y, color = C.text, align = 'left') {
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  }
  function fit(s, maxW) {
    s = String(s);
    if (g.measureText(s).width <= maxW) return s;
    const chars = [...s];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (g.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return chars.slice(0, lo).join('') + '…';
  }
  /** Wraps by character (works for CJK and long tokens). */
  function wrap(s, maxW, maxLines) {
    const out = [];
    let line = '';
    for (const ch of String(s)) {
      if (ch === '\n' || g.measureText(line + ch).width > maxW) {
        out.push(line);
        line = ch === '\n' ? '' : ch;
        if (out.length === maxLines) break;
      } else line += ch;
    }
    if (out.length < maxLines && line) out.push(line);
    if (out.length === maxLines && (line || out.join('').length < [...String(s)].length)) out[maxLines - 1] = fit(out[maxLines - 1] + '…', maxW);
    return out;
  }
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  function lastIndexAt(list, t) {
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return ZH ? `${Math.max(1, m)} 分钟` : `${Math.max(1, m)} min`;
    const h = Math.floor(m / 60);
    return ZH ? `${h} 小时 ${m % 60} 分` : `${h}h ${m % 60}m`;
  }
  function clock(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  /** Real wall-clock time shown at video time t (interpolated between events). */
  function realAt(t) {
    const i = lastIndexAt(events, t);
    if (i < 0) return TL.meta.start;
    if (i >= events.length - 1) return TL.meta.end;
    const a = events[i];
    const b = events[i + 1];
    return a.ts + (b.ts - a.ts) * Math.min(1, (t - a.t) / Math.max(0.001, b.t - a.t));
  }

  // ---------- pieces ----------
  function background() {
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, C.bg1);
    grd.addColorStop(1, C.bg2);
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
  }

  function topBar(t) {
    rect(32, 28, 10, 10, C.red, 5);
    font(15, 800);
    g.letterSpacing = '3px';
    text('DEVIN TIMELAPSE', 52, 39, C.teal);
    g.letterSpacing = '0px';
    font(20, 600);
    text(fit(TL.meta.title, 640), 52, 70, C.text);
    if (TL.meta.project) { font(14); text(TL.meta.project, 52, 92, C.dim); }
    font(40, 700, true);
    text(clock(realAt(t)), W - 32, 66, C.text, 'right');
    const speed = TL.meta.realMs > 0 ? Math.round(TL.meta.realMs / 1000 / (TL.duration - TL.intro - TL.outro)) : 1;
    font(14, 600);
    text(`${new Date(TL.meta.start).toLocaleDateString(ZH ? 'zh-CN' : 'en-US')}  ·  ×${speed}`, W - 32, 92, C.dim, 'right');
  }

  const PX = 32;
  const PY = 110;
  const PW = 800;
  const PH = 500;

  function panelFrame(e) {
    const k = KIND[e.kind] || KIND.tool;
    rect(PX, PY, PW, PH, C.panel, 18);
    rect(PX, PY, PW, 48, '#171d33', 18);
    rect(PX, PY + 30, PW, 18, '#171d33');
    rect(PX + 20, PY + 18, 12, 12, k.color, 6);
    font(15, 700);
    text(k.label, PX + 42, PY + 30, k.color);
    const head = e.kind === 'exec' ? '' : e.file || e.target || '';
    if (head) { font(15, 500, true); text(fit(head, PW - 200), PX + PW - 20, PY + 30, C.dim, 'right'); }
  }

  function drawExec(e, p) {
    rect(PX + 16, PY + 64, PW - 32, PH - 80, C.panel2, 12);
    font(19, 500, true);
    const cmd = e.command || '';
    const typed = [...cmd].slice(0, Math.ceil([...cmd].length * ease(p / 0.35))).join('');
    text('$', PX + 36, PY + 104, C.green);
    text(fit(typed, PW - 110), PX + 58, PY + 104, C.text);
    if (p < 0.35 && Math.floor(p * 40) % 2 === 0) rect(PX + 60 + g.measureText(fit(typed, PW - 110)).width, PY + 88, 10, 20, C.text);
    font(16, 400, true);
    const lines = e.output || [];
    const shown = p < 0.35 ? 0 : Math.ceil(lines.length * ease((p - 0.35) / 0.35));
    lines.slice(0, shown).forEach((l, i) => text(fit(l, PW - 90), PX + 36, PY + 142 + i * 28, '#c9d1d9'));
    if (p > 0.7 && e.error) {
      rect(PX + PW - 140, PY + PH - 64, 104, 32, C.red, 8);
      font(15, 700);
      text(ZH ? '失败' : 'FAILED', PX + PW - 88, PY + PH - 42, '#1a0d12', 'center');
    } else if (p > 0.7 && lines.length) {
      font(15, 700);
      text('✓', PX + PW - 48, PY + PH - 40, C.green, 'center');
    }
  }

  function drawEdit(e, p) {
    rect(PX + 16, PY + 64, PW - 32, PH - 80, '#0f1424', 12);
    font(16, 400, true);
    const lines = e.lines || [];
    const shown = Math.ceil(lines.length * ease(0.2 + p / 0.6));
    lines.slice(0, shown).forEach((l, i) => {
      const y = PY + 84 + i * 23;
      if (l.op === '+') rect(PX + 16, y, PW - 32, 23, 'rgba(63,185,80,0.16)');
      if (l.op === '-') rect(PX + 16, y, PW - 32, 23, 'rgba(255,93,115,0.16)');
      text(l.op, PX + 30, y + 17, l.op === '+' ? C.green : l.op === '-' ? C.red : C.dim);
      text(fit(l.text, PW - 90), PX + 52, y + 17, l.op === ' ' ? '#8b93b8' : '#e6edf3');
    });
    font(15, 700, true);
    text(`+${e.added}`, PX + PW - 110, PY + PH - 34, C.green, 'right');
    text(`-${e.removed}`, PX + PW - 40, PY + PH - 34, C.red, 'right');
  }

  function drawPrompt(e, p) {
    const a = ease(p / 0.25);
    g.globalAlpha = a;
    font(16, 700);
    text(ZH ? '你' : 'You', PX + 40, PY + 104, C.dim);
    font(30, 600);
    wrap(e.text, PW - 90, 8).forEach((l, i) => text(l, PX + 40, PY + 150 + i * 44, C.text));
    g.globalAlpha = 1;
  }

  function drawSay(e, p) {
    font(24, 500);
    const lines = wrap(e.text, PW - 110, 8);
    const total = lines.join('').length;
    let budget = Math.ceil(total * ease(p / 0.6));
    rect(PX + 30, PY + 80, PW - 60, Math.min(PH - 110, 48 + lines.length * 38), 'rgba(167,123,255,0.12)', 16);
    lines.forEach((l, i) => {
      const part = [...l].slice(0, Math.max(0, budget)).join('');
      budget -= [...l].length;
      text(part, PX + 54, PY + 124 + i * 38, C.text);
    });
  }

  function drawPlan(e, p) {
    font(22, 500);
    (e.items || []).forEach((it, i) => {
      const y = PY + 100 + i * 52;
      const done = it.done && p > 0.2 + i * 0.08;
      rect(PX + 40, y - 20, 26, 26, done ? C.teal : 'transparent', 6);
      g.strokeStyle = done ? C.teal : it.active ? C.yellow : C.dim;
      g.lineWidth = 2;
      g.strokeRect(PX + 40, y - 20, 26, 26);
      if (done) { font(18, 800); text('✓', PX + 53, y, '#08201c', 'center'); font(22, 500); }
      text(fit(it.text, PW - 140), PX + 84, y, done ? C.dim : C.text);
    });
  }

  function drawGeneric(e, p) {
    const k = KIND[e.kind] || KIND.tool;
    const cx = PX + PW / 2;
    const cy = PY + 230;
    const r = 70 + 6 * Math.sin(p * Math.PI * 4);
    g.globalAlpha = 0.18;
    rect(cx - r, cy - r, 2 * r, 2 * r, k.color, r);
    g.globalAlpha = 1;
    font(52, 800);
    const icon = { read: '⌕', web: '◎', ask: '?', delegate: '⇄', tool: '⚙' }[e.kind] || '•';
    text(icon, cx, cy + 18, k.color, 'center');
    font(26, 600, e.kind !== 'web');
    text(fit(e.target || e.tool || '', PW - 80), cx, PY + 380, C.text, 'center');
    font(15);
    text(e.tool || '', cx, PY + 414, C.dim, 'center');
  }

  function mainPanel(t) {
    const i = lastIndexAt(featured, t);
    if (i < 0) return;
    const e = featured[i];
    const next = featured[i + 1];
    const dwell = Math.max(0.4, (next ? next.t : TL.duration - TL.outro) - e.t);
    const p = Math.min(1, (t - e.t) / dwell);
    panelFrame(e);
    g.save();
    g.beginPath();
    g.rect(PX, PY + 48, PW, PH - 48);
    g.clip();
    if (e.kind === 'exec') drawExec(e, p);
    else if (e.kind === 'edit') drawEdit(e, p);
    else if (e.kind === 'prompt') drawPrompt(e, p);
    else if (e.kind === 'say') drawSay(e, p);
    else if (e.kind === 'plan') drawPlan(e, p);
    else drawGeneric(e, p);
    g.restore();
  }

  function feed(t) {
    const x = 856;
    const w = W - x - 32;
    rect(x, PY, w, 330, C.panel, 18);
    font(14, 700);
    g.letterSpacing = '2px';
    text(L.activity.toUpperCase(), x + 20, PY + 30, C.dim);
    g.letterSpacing = '0px';
    const i = lastIndexAt(featured, t);
    const recent = featured.slice(Math.max(0, i - 8), i + 1).reverse();
    recent.forEach((e, k) => {
      const age = t - e.t;
      const slide = k === 0 ? 1 - ease(age / 0.25) : 0;
      const y = PY + 64 + k * 30 + slide * -14;
      g.globalAlpha = (1 - slide) * (1 - k * 0.07);
      const kd = KIND[e.kind] || KIND.tool;
      rect(x + 20, y - 10, 8, 8, kd.color, 4);
      font(15, k === 0 ? 700 : 500);
      const label = e.kind === 'exec' ? e.command : e.kind === 'prompt' || e.kind === 'say' ? e.text : e.file || e.target || e.tool;
      text(fit(label || kd.label, w - 60), x + 38, y, k === 0 ? C.text : C.dim);
      g.globalAlpha = 1;
    });
  }

  function counters(t) {
    const x = 856;
    const y = PY + 346;
    const w = W - x - 32;
    rect(x, y, w, 154, C.panel, 18);
    const i = lastIndexAt(events, t);
    const c = i >= 0 ? events[i].c : { tools: 0, files: 0, added: 0, removed: 0, commands: 0 };
    const cells = [
      [String(c.tools), L.tools, C.teal],
      [String(c.files), L.files, C.pink],
      [`+${c.added}`, L.lines, C.green, `-${c.removed}`],
      [String(c.commands), L.commands, C.yellow],
    ];
    cells.forEach(([v, label, color, extra], k) => {
      const cx = x + 20 + (k % 2) * (w / 2);
      const cy = y + 52 + Math.floor(k / 2) * 70;
      font(30, 800, true);
      text(v, cx, cy, color);
      if (extra) { const vw = g.measureText(v).width; font(18, 700, true); text(extra, cx + vw + 8, cy, C.red); }
      font(13);
      text(label, cx, cy + 22, C.dim);
    });
  }

  function timelineBar(t) {
    const x = 32;
    const y = 640;
    const w = W - 64;
    rect(x, y, w, 8, '#20253f', 4);
    const prog = Math.min(1, Math.max(0, (t - TL.intro) / (TL.duration - TL.intro - TL.outro)));
    rect(x, y, w * prog, 8, C.teal, 4);
    const span = TL.duration - TL.intro - TL.outro;
    for (const e of featured) {
      const ex = x + (w * (e.t - TL.intro)) / span;
      const kd = KIND[e.kind] || KIND.tool;
      if (e.kind === 'prompt') {
        g.save();
        g.translate(ex, y + 4);
        g.rotate(Math.PI / 4);
        rect(-6, -6, 12, 12, '#ffffff');
        g.restore();
      } else rect(ex - 1.5, y + 16, 3, 10, e.t <= t ? kd.color : '#3a3f5c');
    }
    rect(x + w * prog - 3, y - 6, 6, 20, '#ffffff', 3);
    font(13);
    text(fmtDur(TL.meta.realMs), x + w, y + 46, C.dim, 'right');
    text(clock(TL.meta.start), x, y + 46, C.dim);
  }

  function intro(t) {
    const a = t < TL.intro - 0.5 ? 1 : 1 - (t - (TL.intro - 0.5)) / 0.5;
    g.globalAlpha = Math.max(0, a);
    background();
    font(20, 800);
    g.letterSpacing = '6px';
    text('DEVIN TIMELAPSE', W / 2, 250, C.teal, 'center');
    g.letterSpacing = '0px';
    font(54, 800);
    wrap(TL.meta.title, W - 200, 2).forEach((l, i) => text(l, W / 2, 330 + i * 66, C.text, 'center'));
    font(22, 500);
    text([TL.meta.project, new Date(TL.meta.start).toLocaleString(ZH ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join('  ·  '), W / 2, 470, C.dim, 'center');
    font(26, 700);
    text(L.of(fmtDur(TL.meta.realMs), Math.round(TL.duration)), W / 2, 530, C.pink, 'center');
    g.globalAlpha = 1;
  }

  function outro(t) {
    const start = TL.duration - TL.outro;
    const a = ease((t - start) / 0.6);
    g.globalAlpha = a * 0.92;
    rect(0, 0, W, H, C.bg1);
    g.globalAlpha = a;
    const c = TL.totals;
    font(22, 600);
    text(L.summary, W / 2, 210, C.dim, 'center');
    const cells = [[c.tools, L.tools, C.teal], [c.files, L.files, C.pink], [c.added + c.removed, L.lines, C.green], [c.commands, L.commands, C.yellow]];
    cells.forEach(([v, label, color], k) => {
      const cx = W / 2 + (k - 1.5) * 260;
      font(64, 800, true);
      text(String(v), cx, 340, color, 'center');
      font(18);
      text(label, cx, 376, C.dim, 'center');
    });
    font(24, 700);
    text(fit(TL.meta.title, W - 200), W / 2, 470, C.text, 'center');
    font(16);
    text(L.footer, W / 2, 640, C.dim, 'center');
    g.globalAlpha = 1;
  }

  function renderInto(ctx, t) {
    g = ctx;
    g.textBaseline = 'alphabetic';
    background();
    if (t >= TL.intro - 0.5) {
      topBar(t);
      mainPanel(t);
      feed(t);
      counters(t);
      timelineBar(t);
    }
    if (t < TL.intro) intro(t);
    if (t > TL.duration - TL.outro) outro(t);
  }

  // ---------- page ----------
  const canvas = document.getElementById('c');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  /** Used by the exporter: draw frame t and return it as a JPEG data URL. */
  window.renderFrame = (t, quality = 0.9) => {
    renderInto(ctx, t);
    return canvas.toDataURL('image/jpeg', quality);
  };
  window.TIMELAPSE_DURATION = TL.duration;

  if (window.TIMELAPSE_EXPORT) {
    renderInto(ctx, 0);
    window.__ready = true;
    return;
  }

  const playBtn = document.getElementById('play');
  const scrub = document.getElementById('scrub');
  scrub.max = String(TL.duration);
  let playing = true;
  let t0 = performance.now();
  let pos = 0;
  playBtn.onclick = () => {
    playing = !playing;
    if (playing) { if (pos >= TL.duration) pos = 0; t0 = performance.now() - pos * 1000; }
    playBtn.textContent = playing ? '❚❚' : '▶';
  };
  scrub.oninput = () => { pos = Number(scrub.value); t0 = performance.now() - pos * 1000; renderInto(ctx, pos); };
  function loop(now) {
    if (playing) {
      pos = (now - t0) / 1000;
      if (pos >= TL.duration) { pos = TL.duration; playing = false; playBtn.textContent = '▶'; }
      scrub.value = String(pos);
      renderInto(ctx, pos);
    }
    requestAnimationFrame(loop);
  }
  window.__ready = true;
  requestAnimationFrame(loop);
})();

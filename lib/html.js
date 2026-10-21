'use strict';
// Self-contained HTML: the timeline JSON and the player script inlined, no network needed.

const fs = require('node:fs');
const path = require('node:path');

const PLAYER = path.join(__dirname, '..', 'public', 'player.js');

/** JSON safe to inline in <script> (no "</script>", no U+2028/2029 surprises). */
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function buildHtml(timeline, { lang = 'en', exportMode = false } = {}) {
  const player = fs.readFileSync(PLAYER, 'utf8');
  const data = { ...timeline, lang };
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Devin Timelapse</title>
<style>
  html,body{margin:0;background:#05070d;color:#eef0ff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
  main{display:flex;flex-direction:column;align-items:center;gap:12px;padding:${exportMode ? 0 : 20}px}
  canvas{width:${exportMode ? '1280px' : 'min(1280px,96vw)'};height:auto;border-radius:${exportMode ? 0 : 14}px;${exportMode ? '' : 'box-shadow:0 20px 80px rgba(120,80,255,.3)'}}
  .bar{display:${exportMode ? 'none' : 'flex'};gap:12px;align-items:center;width:min(1280px,96vw)}
  button{font:inherit;width:44px;height:36px;border-radius:999px;border:0;background:#2ee6c5;color:#08201c;font-weight:800;cursor:pointer}
  input[type=range]{flex:1;accent-color:#2ee6c5}
</style></head>
<body><main><canvas id="c" width="1280" height="720"></canvas>
<div class="bar"><button id="play">❚❚</button><input id="scrub" type="range" min="0" step="0.01" value="0"></div></main>
<script>window.TIMELAPSE=${inlineJson(data)};${exportMode ? 'window.TIMELAPSE_EXPORT=true;' : ''}</script>
<script>${player.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>
`;
}

module.exports = { inlineJson, buildHtml };

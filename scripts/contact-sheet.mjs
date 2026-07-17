#!/usr/bin/env node
/**
 * scripts/contact-sheet.mjs — 생성 후보/프로브 검수용 컨택트시트 HTML 생성기 (무npm·자기완결)
 *
 * PixelLab review 팩(4/16/64 후보)이나 프로브 배치 결과를 격자 HTML 로 만들어
 * 사용자가 브라우저에서 훑어보고 채택할 번호를 고르게 한다(히어로 에셋 검수 루프).
 * 이미지는 base64 로 임베드되어 HTML 파일 하나만 열면 된다(서버 불필요).
 *
 * 사용:
 *   node scripts/contact-sheet.mjs <png파일|디렉터리>... [--out sheet.html] [--title "제목"]
 *                                  [--scale 4] [--cols 8] [--open]
 *
 *   --out    출력 HTML 경로 (기본: os.tmpdir()/pixellab-forge-sheets/sheet-<n>.html)
 *   --scale  픽셀아트 확대 배율 (기본 4, image-rendering: pixelated)
 *   --cols   열 수 (기본: 장수에 따라 자동)
 *   --open   생성 후 기본 브라우저로 열기
 *
 * 셀 번호는 0-based — select_object_frames(indices=[...]) 에 그대로 쓴다.
 * 셀 클릭으로 선택 토글, 하단에 선택된 인덱스 목록이 표시된다.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

function collectImages(inputs) {
  const files = [];
  for (const p of inputs) {
    if (!existsSync(p)) { console.error(`경고: 없음 — ${p}`); continue; }
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (EXTS.has(path.extname(f).toLowerCase())) files.push(path.join(p, f));
      }
    } else if (EXTS.has(path.extname(p).toLowerCase())) files.push(p);
    else console.error(`경고: 이미지 아님 — ${p}`);
  }
  return files;
}

function mimeOf(file) {
  const e = path.extname(file).toLowerCase();
  return e === '.jpg' || e === '.jpeg' ? 'image/jpeg' : e === '.webp' ? 'image/webp' : e === '.gif' ? 'image/gif' : 'image/png';
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export function buildHtml(files, opts = {}) {
  const title = opts.title || '컨택트시트';
  const scale = Number(opts.scale) || 4;
  const cols = Number(opts.cols) || (files.length <= 4 ? 2 : files.length <= 16 ? 4 : 8);
  const cells = files.map((f, i) => {
    const b64 = readFileSync(f).toString('base64');
    return `<figure class="cell" data-i="${i}" title="${esc(f)}">
  <img src="data:${mimeOf(f)};base64,${b64}" alt="${i}" style="transform-origin: top left;" />
  <figcaption><b>#${i}</b> ${esc(path.basename(f))}</figcaption>
</figure>`;
  }).join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { background: #1b1b22; color: #e6e6ea; font: 14px/1.5 system-ui, sans-serif; margin: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #9a9aa5; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, minmax(0, 1fr)); gap: 10px; }
  .cell { margin: 0; padding: 8px; background: #26262f; border: 2px solid #3a3a46; border-radius: 8px; cursor: pointer; overflow: auto; }
  .cell.sel { border-color: #6ee7a0; background: #23342a; }
  .cell img { image-rendering: pixelated; zoom: ${scale}; display: block;
              background: repeating-conic-gradient(#2e2e38 0 25%, #26262f 0 50%) 0 0 / 16px 16px; }
  figcaption { font-size: 12px; color: #b8b8c2; margin-top: 6px; word-break: break-all; }
  #picked { position: sticky; bottom: 0; background: #14141a; border-top: 1px solid #3a3a46; padding: 10px 4px; margin-top: 16px; font-size: 15px; }
  #picked b { color: #6ee7a0; }
</style></head><body>
<h1>${esc(title)}</h1>
<p class="hint">셀 클릭 = 선택 토글. 번호는 0-based — select_object_frames(indices=[...]) 에 그대로 사용.</p>
<div class="grid">
${cells}
</div>
<div id="picked">선택: <b id="sel">(없음)</b></div>
<script>
  const sel = new Set();
  document.querySelectorAll('.cell').forEach((c) => c.addEventListener('click', () => {
    const i = Number(c.dataset.i);
    if (sel.has(i)) { sel.delete(i); c.classList.remove('sel'); } else { sel.add(i); c.classList.add('sel'); }
    document.getElementById('sel').textContent = sel.size ? [...sel].sort((a, b) => a - b).join(', ') : '(없음)';
  }));
</script>
</body></html>`;
}

function openInBrowser(file) {
  const url = pathToFileURL(file).href;
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length === 0) {
    console.error('사용법: node scripts/contact-sheet.mjs <png파일|디렉터리>... [--out sheet.html] [--title "제목"] [--scale 4] [--cols 8] [--open]');
    process.exit(1);
  }
  const files = collectImages(args._);
  if (files.length === 0) { console.error('이미지 0장 — 종료.'); process.exit(1); }
  let out = args.out && args.out !== 'true' ? path.resolve(args.out) : null;
  if (!out) {
    const dir = path.join(os.tmpdir(), 'pixellab-forge-sheets');
    mkdirSync(dir, { recursive: true });
    let n = 1; while (existsSync(path.join(dir, `sheet-${n}.html`))) n++;
    out = path.join(dir, `sheet-${n}.html`);
  }
  writeFileSync(out, buildHtml(files, args));
  console.log(`컨택트시트 생성: ${out} (${files.length}장)`);
  if (args.open === 'true') { openInBrowser(out); console.log('브라우저로 열었습니다.'); }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

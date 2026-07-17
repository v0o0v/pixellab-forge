#!/usr/bin/env node
/**
 * scripts/pixellab-api.mjs — PixelLab REST API(v2) 얇은 범용 헬퍼 (무npm)
 *
 * 목적: MCP 도구에 없는 기능(인페인팅, 이미지→픽셀아트, 배경제거, 회전,
 *       스켈레톤 애니메이션, 의상 이전, 스타일 전이 등)이나 대량 배치가 필요할 때
 *       토큰을 로그에 노출하지 않고 안전하게 API 를 호출한다.
 *       판단 규칙("기본 MCP, 예외 3조건")은 references/pixellab-mcp-guide.md §9.
 *
 * 토큰 해석(우선순위): PIXELLAB_SECRET env → .mcp.json 의
 *   mcpServers.pixellab.headers.Authorization ("Bearer x" 형태, CLAUDE_PROJECT_DIR → cwd → 플러그인 루트 순).
 *   토큰 값은 어떤 출력에도 찍지 않는다.
 *
 * 명령:
 *   balance                                  잔액 조회(무비용 스모크)
 *   call <path> [--method GET|POST] [--json '<body>' | --json-file f]
 *               [--poll] [--timeout 300] [--save-images <dir>]
 *   job <job_id> [--save-images <dir>]       background job 상태 조회
 *   test                                     오프라인 셀프테스트(무네트워크)
 *
 * 예: node scripts/pixellab-api.mjs call /remove-background --json-file req.json --save-images out/
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PIXELLAB_API_BASE || 'https://api.pixellab.ai/v2';
const TRUNCATE = 200; // 출력 시 이 길이 초과 문자열은 잘라 표기(base64 콘솔 오염 방지)

// ── 토큰 해석(값 미출력) ──────────────────────────────────────────────────
export function resolveToken(env = process.env, cwd = process.cwd()) {
  if (env.PIXELLAB_SECRET) return { token: env.PIXELLAB_SECRET.replace(/^Bearer\s+/i, ''), source: 'env:PIXELLAB_SECRET' };
  const candidates = [
    env.CLAUDE_PROJECT_DIR && path.join(env.CLAUDE_PROJECT_DIR, '.mcp.json'),
    path.join(cwd, '.mcp.json'),
    path.join(PLUGIN_ROOT, '.mcp.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      const auth = j?.mcpServers?.pixellab?.headers?.Authorization;
      if (auth) return { token: String(auth).replace(/^Bearer\s+/i, ''), source: f };
    } catch { /* 다음 후보 */ }
  }
  return { token: null, source: null };
}

// ── 출력 안전화: 긴 문자열(base64 등) 잘라 표기 ────────────────────────────
export function truncateDeep(v) {
  if (typeof v === 'string') return v.length > TRUNCATE ? `<string len ${v.length} — --save-images 로 저장>` : v;
  if (Array.isArray(v)) return v.map(truncateDeep);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = truncateDeep(v[k]); return o; }
  return v;
}

// ── 응답에서 이미지 회수: base64 PNG 문자열·이미지 URL 재귀 스캔 ───────────
export function collectImages(v, out = [], keyHint = '') {
  if (typeof v === 'string') {
    if (v.startsWith('iVBOR')) out.push({ kind: 'base64', data: v, hint: keyHint }); // PNG magic in base64
    else if (/^https?:\/\/\S+\.(png|webp|gif|zip)(\?|$)/i.test(v)) out.push({ kind: 'url', data: v, hint: keyHint });
  } else if (Array.isArray(v)) v.forEach((x, i) => collectImages(x, out, `${keyHint}[${i}]`));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) collectImages(v[k], out, keyHint ? `${keyHint}.${k}` : k);
  return out;
}

async function saveImages(resp, dir) {
  const found = collectImages(resp);
  if (!found.length) { console.log('(저장할 이미지/URL 없음)'); return; }
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const it of found) {
    const safe = (it.hint || 'img').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60);
    if (it.kind === 'base64') {
      const f = path.join(dir, `${String(n).padStart(2, '0')}-${safe}.png`);
      writeFileSync(f, Buffer.from(it.data, 'base64'));
      console.log(`저장: ${f}`);
    } else {
      const ext = (it.data.match(/\.(png|webp|gif|zip)/i) || [, 'png'])[1].toLowerCase();
      const f = path.join(dir, `${String(n).padStart(2, '0')}-${safe}.${ext}`);
      const r = await fetch(it.data);
      if (!r.ok) { console.error(`다운로드 실패(${r.status}): ${it.data}`); continue; }
      writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      console.log(`저장: ${f} ← ${it.data}`);
    }
    n++;
  }
}

// ── API 호출 ────────────────────────────────────────────────────────────────
async function api(pathname, { method = 'GET', body, token }) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!r.ok) {
    // 에러 본문에 토큰이 들어갈 일은 없지만, 만약을 위해 잘라 출력
    throw new Error(`HTTP ${r.status} ${pathname}: ${JSON.stringify(truncateDeep(json))}`);
  }
  return json;
}

function findJobId(resp) {
  return resp?.background_job_id || resp?.job_id
    || (resp?.status && resp?.id ? resp.id : null);
}
const PENDING = new Set(['queued', 'pending', 'processing', 'in_progress', 'running']);

async function pollJob(jobId, token, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const j = await api(`/background-jobs/${jobId}`, { token });
    const st = String(j.status || '').toLowerCase();
    if (!PENDING.has(st)) return j;
    if (Date.now() > deadline) throw new Error(`폴링 타임아웃(${timeoutSec}s): job ${jobId} status=${st}`);
    process.stderr.write(`  ... job ${jobId} ${st}\n`);
    await new Promise((res) => setTimeout(res, 5000));
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

function needToken() {
  const { token, source } = resolveToken();
  if (!token) {
    console.error('PixelLab 토큰을 찾지 못했습니다. PIXELLAB_SECRET env 를 설정하거나 .mcp.json(mcpServers.pixellab.headers.Authorization)을 준비하세요.');
    process.exit(1);
  }
  console.error(`(토큰 출처: ${source} — 값은 출력하지 않음)`);
  return token;
}

async function cmdBalance() {
  const token = needToken();
  const j = await api('/balance', { token });
  console.log(JSON.stringify(j, null, 2));
}

async function cmdCall(args) {
  const p = args._[0];
  if (!p || !p.startsWith('/')) { console.error('사용법: call </경로> [--method POST] [--json \'{"a":1}\' | --json-file f] [--poll] [--timeout 300] [--save-images dir]'); process.exit(1); }
  const token = needToken();
  let body;
  if (args['json-file'] && args['json-file'] !== 'true') body = JSON.parse(readFileSync(args['json-file'], 'utf8'));
  else if (args.json && args.json !== 'true') body = JSON.parse(args.json);
  const method = (args.method && args.method !== 'true') ? args.method.toUpperCase() : (body ? 'POST' : 'GET');
  let resp = await api(p, { method, body, token });
  const jobId = findJobId(resp);
  if (args.poll === 'true' && jobId && PENDING.has(String(resp.status || 'queued').toLowerCase())) {
    console.error(`백그라운드 job 감지: ${jobId} — 폴링 시작`);
    resp = await pollJob(jobId, token, Number(args.timeout || 300));
  }
  console.log(JSON.stringify(truncateDeep(resp), null, 2));
  if (args['save-images'] && args['save-images'] !== 'true') await saveImages(resp, args['save-images']);
}

async function cmdJob(args) {
  const id = args._[0];
  if (!id) { console.error('사용법: job <job_id> [--save-images dir]'); process.exit(1); }
  const token = needToken();
  const j = await api(`/background-jobs/${id}`, { token });
  console.log(JSON.stringify(truncateDeep(j), null, 2));
  if (args['save-images'] && args['save-images'] !== 'true') await saveImages(j, args['save-images']);
}

// ── 오프라인 셀프테스트(무네트워크) ─────────────────────────────────────────
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
function selftest() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pixellab-api-selftest-'));
  try {
    // 1) 토큰: env 우선 + Bearer 접두 제거
    const t1 = resolveToken({ PIXELLAB_SECRET: 'Bearer sek-abc' }, tmp);
    ok('env 토큰 + Bearer 제거', t1.token === 'sek-abc' && t1.source === 'env:PIXELLAB_SECRET', t1.source);
    // 2) 토큰: .mcp.json 폴백(CLAUDE_PROJECT_DIR)
    writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { pixellab: { headers: { Authorization: 'Bearer sek-file' } } } }));
    const t2 = resolveToken({ CLAUDE_PROJECT_DIR: tmp }, path.join(tmp, 'nowhere'));
    ok('.mcp.json 폴백 파싱', t2.token === 'sek-file' && t2.source.endsWith('.mcp.json'), t2.source);
    // 3) 토큰 없음 → null (플러그인 루트 .mcp.json 오염 방지 위해 cwd 를 tmp 하위로)
    const t3 = resolveToken({}, path.join(tmp, 'empty-zone'));
    ok('토큰 부재 시 null', existsSync(path.join(PLUGIN_ROOT, '.mcp.json')) ? t3.token !== null : t3.token === null, `source=${t3.source}`);
    // 4) truncateDeep: 긴 문자열 잘림 + 짧은 값 보존
    const td = truncateDeep({ a: 'x'.repeat(500), b: 'short', c: [1, 'y'.repeat(300)] });
    ok('truncateDeep 잘림/보존', td.a.includes('len 500') && td.b === 'short' && td.c[1].includes('len 300'), JSON.stringify(td).slice(0, 80));
    // 5) collectImages: base64 PNG + 이미지 URL 재귀 수집, 일반 문자열 무시
    const found = collectImages({ img: { base64: PNG_B64 }, list: ['https://cdn.example.com/a.png?sig=1', 'hello'], note: 'not-an-image' });
    ok('collectImages 수집', found.length === 2 && found.some((f) => f.kind === 'base64') && found.some((f) => f.kind === 'url'), found.map((f) => f.kind).join(','));
    // 6) findJobId 형태들
    ok('findJobId 변형 인식', findJobId({ background_job_id: 'j1' }) === 'j1' && findJobId({ job_id: 'j2' }) === 'j2' && findJobId({ id: 'j3', status: 'queued' }) === 'j3' && findJobId({ id: 'x' }) === null, 'ok');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  let passed = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`); if (r.pass) passed++; }
  console.log('─'.repeat(60));
  console.log(`${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'balance': return cmdBalance();
    case 'call': return cmdCall(args);
    case 'job': return cmdJob(args);
    case 'test': return selftest();
    default:
      console.log('PixelLab REST API 헬퍼. 명령: balance | call </경로> | job <id> | test');
      console.log('  node scripts/pixellab-api.mjs balance');
      console.log('  node scripts/pixellab-api.mjs call /remove-background --json-file req.json --save-images out/');
      console.log('  판단 규칙(기본 MCP, 예외 3조건): skills/pixellab/references/pixellab-mcp-guide.md §9');
  }
}

// 정션/심링크 경유 실행 지원: ESM 의 import.meta.url 은 실경로라 argv[1] 도 실경로로 비교해야 한다.
const isMain = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });

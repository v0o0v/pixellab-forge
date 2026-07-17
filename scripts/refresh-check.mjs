#!/usr/bin/env node
/**
 * scripts/refresh-check.mjs — PixelLab 문서 학습(증류) 신선도 판정 (무npm·무네트워크)
 *
 * 스킬 발동 시 이 스크립트로 마지막 학습일(refresh-state.json)에서 intervalDays(기본 30일)가
 * 지났는지 판정한다. STALE 이면 재학습 프로토콜(references/pixellab-mcp-guide.md §10)을 따른다
 * — 원 작업(생성)을 먼저 끝내고 세션 마무리에 수행.
 *
 * 명령:
 *   check (기본)        FRESH/STALE 판정 출력 (항상 exit 0 — 정보성)
 *   mark [--date YYYY-MM-DD]   재학습 완료 기록(기본: 오늘). lastCollectedAt 갱신.
 *   test                결정적 셀프테스트(무네트워크)
 *
 * env:
 *   PIXELLAB_REFRESH_STATE  상태 파일 경로 오버라이드(테스트용)
 *   PIXELLAB_NOW            오늘 날짜 오버라이드 YYYY-MM-DD(테스트용)
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE = path.join(PLUGIN_ROOT, 'skills', 'pixellab', 'references', 'refresh-state.json');

export function statePath(env = process.env) {
  return env.PIXELLAB_REFRESH_STATE || DEFAULT_STATE;
}
export function readState(env = process.env) {
  const f = statePath(env);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}
function today(env = process.env) {
  if (env.PIXELLAB_NOW) return parseDay(env.PIXELLAB_NOW);
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
/**
 * evaluate(state, nowMs) → { status: 'FRESH'|'STALE'|'UNKNOWN', days, interval, lastCollectedAt }
 * UNKNOWN = 상태 파일 부재/파싱 불가/날짜 불량 → 보수적으로 재학습 권장.
 */
export function evaluate(state, nowMs) {
  const interval = Number(state && state.intervalDays) || 30;
  const last = parseDay(state && state.lastCollectedAt);
  if (Number.isNaN(last) || Number.isNaN(nowMs)) return { status: 'UNKNOWN', days: null, interval, lastCollectedAt: state && state.lastCollectedAt };
  const days = Math.floor((nowMs - last) / 86400000);
  return { status: days >= interval ? 'STALE' : 'FRESH', days, interval, lastCollectedAt: state.lastCollectedAt };
}

function cmdCheck() {
  const r = evaluate(readState(), today());
  if (r.status === 'FRESH') {
    console.log(`FRESH — 학습 ${r.days}일 경과 (임계 ${r.interval}일, 수집일 ${r.lastCollectedAt}). 재학습 불필요.`);
  } else if (r.status === 'STALE') {
    console.log(`STALE — 학습 ${r.days}일 경과 (임계 ${r.interval}일, 수집일 ${r.lastCollectedAt}).`);
    console.log('→ 재학습 프로토콜 실행: skills/pixellab/references/pixellab-mcp-guide.md §10');
    console.log('  (원 작업을 먼저 끝내고 세션 마무리에 수행. 완료 후: node scripts/refresh-check.mjs mark)');
  } else {
    console.log(`UNKNOWN — 상태 파일(${statePath()}) 부재/불량. 재학습 프로토콜(가이드 §10) 실행 후 mark 로 기록 권장.`);
  }
}

function cmdMark(args) {
  const f = statePath();
  const state = readState() || { _doc: 'PixelLab 문서 학습 신선도 상태', intervalDays: 30, sources: [] };
  const date = (args.date && args.date !== 'true') ? args.date : (() => {
    const t = new Date(today());
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  })();
  if (Number.isNaN(parseDay(date))) { console.error(`날짜 형식 오류(YYYY-MM-DD): ${date}`); process.exit(1); }
  state.lastCollectedAt = date;
  writeFileSync(f, JSON.stringify(state, null, 2) + '\n');
  console.log(`기록: lastCollectedAt = ${date} → ${f}`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

function selftest() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pixellab-refresh-selftest-'));
  const sf = path.join(tmp, 'state.json');
  try {
    // 1) 29일 경과 → FRESH
    writeFileSync(sf, JSON.stringify({ lastCollectedAt: '2026-07-17', intervalDays: 30 }));
    const r1 = evaluate(readState({ PIXELLAB_REFRESH_STATE: sf }), parseDay('2026-08-15'));
    ok('29일 → FRESH', r1.status === 'FRESH' && r1.days === 29, `${r1.status}/${r1.days}`);
    // 2) 정확히 30일 → STALE (경계 포함)
    const r2 = evaluate(readState({ PIXELLAB_REFRESH_STATE: sf }), parseDay('2026-08-16'));
    ok('30일 → STALE(경계 포함)', r2.status === 'STALE' && r2.days === 30, `${r2.status}/${r2.days}`);
    // 3) intervalDays 커스텀(7일) 존중
    writeFileSync(sf, JSON.stringify({ lastCollectedAt: '2026-07-17', intervalDays: 7 }));
    const r3 = evaluate(readState({ PIXELLAB_REFRESH_STATE: sf }), parseDay('2026-07-24'));
    ok('intervalDays=7 존중', r3.status === 'STALE' && r3.interval === 7, `${r3.status}/${r3.interval}`);
    // 4) 상태 파일 부재 → UNKNOWN
    const r4 = evaluate(readState({ PIXELLAB_REFRESH_STATE: path.join(tmp, 'nope.json') }), parseDay('2026-07-24'));
    ok('파일 부재 → UNKNOWN', r4.status === 'UNKNOWN', r4.status);
    // 5) 날짜 불량 → UNKNOWN
    writeFileSync(sf, JSON.stringify({ lastCollectedAt: 'not-a-date' }));
    const r5 = evaluate(readState({ PIXELLAB_REFRESH_STATE: sf }), parseDay('2026-07-24'));
    ok('날짜 불량 → UNKNOWN', r5.status === 'UNKNOWN', r5.status);
    // 6) 실제 리포 상태 파일이 파싱 가능하고 필수 필드 보유
    const real = readState({});
    ok('리포 상태 파일 유효', !!(real && real.lastCollectedAt && real.intervalDays && Array.isArray(real.sources)), JSON.stringify(real && real.lastCollectedAt));
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  let passed = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`); if (r.pass) passed++; }
  console.log('─'.repeat(60));
  console.log(`${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'check';
  const args = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'check': return cmdCheck();
    case 'mark': return cmdMark(args);
    case 'test': return selftest();
    default:
      console.log('PixelLab 문서 학습 신선도. 명령: check(기본) | mark [--date YYYY-MM-DD] | test');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

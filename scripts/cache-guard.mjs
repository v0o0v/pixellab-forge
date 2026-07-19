#!/usr/bin/env node
/**
 * scripts/cache-guard.mjs — PreToolUse 훅(비차단)
 *
 * PixelLab MCP 의 생성/애니메이션 호출 직전에 실행돼, 재사용 캐시에 유사 이미지가 있으면
 * 경고를 출력한다(생성 전 재사용 유도). 기본은 절대 차단하지 않는다(exit 0) — 오탐 위험 회피.
 *
 * stdin: Claude Code 가 tool 호출 정보 JSON 을 준다(tool_name, tool_input, ...).
 * 동작:
 *   - tool_name 이 mcp__pixellab__(create|animate).* 가 아니면 즉시 exit 0(무동작).
 *   - tool_input 에서 description/prompt/item_descriptions 등을 뽑아 pixellab-cache 의 find 로직으로 조회.
 *   - 최고 score ≥ REUSE_THRESHOLD 매치가 있으면 stderr 로 경고(비차단, exit 0).
 *   - PIXELLAB_GUARD_STRICT=1 이면 강한 경고 문구(그래도 비차단 — 차단은 문서로만 안내).
 *   - generation 사용 추정 로그를 ${CLAUDE_PLUGIN_DATA}/log/generations.log 에 append(실패 무시).
 *   - 어떤 예외도 tool 실행을 막지 않도록 try/catch 로 감싸고 항상 exit 0.
 */
import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveRoots, findMatches, absImagePath, REUSE_THRESHOLD, BackendUnavailableError } from './pixellab-cache.mjs';
import { readState, evaluate } from './refresh-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(raw); } };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { raw += c; });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      // stdin 이 없는 환경(수동 실행)에서 무한 대기 방지
      if (process.stdin.isTTY) done();
    } catch { done(); }
  });
}

// tool_input 에서 사람이 읽을 설명 문자열들을 수집한다.
function collectDescriptions(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  const pushStr = (v) => { if (typeof v === 'string' && v.trim()) out.push(v.trim()); };
  pushStr(input.description);
  pushStr(input.prompt);
  pushStr(input.text);
  pushStr(input.name);
  // item_descriptions: 문자열 배열 또는 {description} 객체 배열
  const items = input.item_descriptions || input.items || input.descriptions;
  if (Array.isArray(items)) {
    for (const it of items) {
      if (typeof it === 'string') pushStr(it);
      else if (it && typeof it === 'object') { pushStr(it.description); pushStr(it.prompt); pushStr(it.name); }
    }
  }
  return out;
}

function logDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'pixellab-forge');
  return path.join(base, 'log');
}

async function run() {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
  const toolName = payload.tool_name || payload.toolName || '';
  const input = payload.tool_input || payload.toolInput || payload.input || {};

  // PixelLab 생성/애니메이션 호출이 아니면 무동작.
  if (!/^mcp__pixellab__(create|animate)/.test(toolName)) return;

  const descriptions = collectDescriptions(input);
  const strict = process.env.PIXELLAB_GUARD_STRICT === '1';
  const roots = resolveRoots();

  // 문서 학습 신선도 경고(비차단) — 스킬이 발동 안 된 생성 경로에서도 재학습 필요를 알린다.
  try {
    const d = new Date();
    const fr = evaluate(readState(), Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (fr.status !== 'FRESH') {
      process.stderr.write(`📚 [pixellab-forge] 문서 학습 ${fr.status === 'STALE' ? fr.days + '일 경과(임계 ' + fr.interval + '일)' : '기록 없음'} — 재학습 프로토콜(references/pixellab-mcp-guide.md §10)을 세션 마무리에 수행하세요.\n`);
    }
  } catch { /* 신선도 확인 실패는 무시(생성 미차단) */ }

  // generation 사용 추정 로그(타임스탬프 없이 — Date 미사용. 도구/설명 요약만).
  try {
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    const summary = descriptions.length ? descriptions.map((d) => d.slice(0, 80)).join(' | ') : '(no description)';
    appendFileSync(path.join(dir, 'generations.log'), `${toolName}\t${descriptions.length}items\t${summary}\n`);
  } catch { /* 로깅 실패는 무시 */ }

  // 캐시 조회 → 최고 매치 경고(비차단).
  // 훅은 rebuild 금지(allowRebuild:false) — 신선 인덱스일 때만 후보 조회, 부재/stale/백엔드부재 시 skip.
  let warned = false;
  let backendWarned = false;
  for (const desc of descriptions) {
    let ranked;
    try {
      ranked = findMatches({ prompt: desc, tags: [] }, roots, { top: 1, allowRebuild: false });
    } catch (e) {
      // 백엔드(better-sqlite3) 사용 불가 → 1회만 setup 힌트, 비차단. 그 외 예외도 흡수(생성 미차단).
      if (e instanceof BackendUnavailableError && !backendWarned) {
        process.stderr.write('⚠️ [pixellab-forge] 재사용 인덱스 백엔드(better-sqlite3) 사용 불가 — 후보 조회 건너뜀(생성은 계속). setup: node "<plugin>/scripts/pixellab-cache.mjs" setup\n');
        backendWarned = true;
      }
      continue;
    }
    if (ranked.length && ranked[0].s >= REUSE_THRESHOLD) {
      const best = ranked[0];
      const abs = absImagePath(best.e, roots);
      const prefix = strict ? '⚠️⚠️ [pixellab-forge] STRICT' : '⚠️ [pixellab-forge]';
      process.stderr.write(`${prefix} 유사 캐시 발견 (score ${best.s.toFixed(2)}, ${best.e.scope}): "${desc.slice(0, 60)}"\n`);
      process.stderr.write(`   재사용 후보: ${abs}\n`);
      process.stderr.write(`   → 재사용하면 generation 비용 0. 계속 생성하려면 그대로 진행(차단 안 함).\n`);
      warned = true;
    }
  }
  if (strict && warned) {
    process.stderr.write('   (PIXELLAB_GUARD_STRICT=1: 강한 경고 모드지만 기본 비차단. 차단은 오탐 위험이라 문서 안내로만 둔다.)\n');
  }
}

// 어떤 경우에도 tool 실행을 막지 않는다 — 항상 exit 0.
run().then(() => process.exit(0)).catch(() => process.exit(0));

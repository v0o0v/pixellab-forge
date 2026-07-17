#!/usr/bin/env node
/**
 * scripts/pixellab-cache.mjs — PixelLab 생성 이미지 재사용 캐시 코어 CLI (무npm·무네트워크)
 *
 * 목적: PixelLab MCP 로 새 픽셀아트를 생성하기 "전에" 유사 이미지가 이미 캐시에 있는지 조회하고,
 *       있으면 그 파일을 재사용해 generation 비용을 0 으로 만든다.
 *
 * 하이브리드 캐시(2계층):
 *   - global  = 여러 프로젝트가 공유하는 기본 라이브러리(전역).
 *   - project = 현재 프로젝트 로컬(전역을 덮어쓰는 오버라이드).
 *   find 는 project → global 순으로 둘 다 조회하고, id 중복 시 project 를 우선한다.
 *
 * 루트 해석(환경변수):
 *   global  = PIXELLAB_CACHE_GLOBAL  || <PLUGIN_ROOT>/library  (플러그인 repo 안 — git 커밋·push, standalone·설치형 공유)
 *   project = PIXELLAB_CACHE_PROJECT || (CLAUDE_PROJECT_DIR ? <그것>/.pixellab-cache : <cwd>/.pixellab-cache)
 *   각 루트에 index.json(메타 대장) + images/(PNG 원본).
 *
 * 명령:
 *   init                              두 캐시 루트(index.json + images/) 생성
 *   find "<설명>" [옵션]              유사 이미지 조회(재사용/신규 판정)
 *   add  --id --prompt --file [옵션]  캐시에 등록(파일 복사 + 메타 append)
 *   list [--tags a,b] [--scope ...]   목록
 *   get  <id>                         단일 항목 메타 출력
 *   config                            해석된 루트/임계값 출력
 *   prune                             파일 없는 항목 정리 + 용량 리포트
 *   test | --selftest                 결정적 셀프테스트
 *
 * 재사용 판정: 유사도 score ∈ [0,1]. 임계값 REUSE_THRESHOLD=0.6 이상이면 "재사용 권장".
 *   score = 0.5×(prompt 대칭 Jaccard) + 0.5×(질의 포함도). 질의에 태그가 있으면 0.7×prompt+0.3×태그겹침.
 *   view/size/tool/anchor(스타일 앵커) 일치 소폭 보정. --file 로 준 이미지의 contentHash 가 캐시와 같으면 score=1.0(정확 중복).
 *   (임베딩 없이 결정적 어휘 유사도 — 무npm. 정확 매칭이 아니라 후보 추천이다.)
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
  readdirSync, statSync, rmSync, mkdtempSync, utimesSync, realpathSync,
} from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import {
  ensureFresh, getCandidates, rebuild as rebuildIndex, upsertOne, removeIds,
  closeAll, BackendUnavailableError, allIds,
} from './pixellab-index.mjs';

export { BackendUnavailableError } from './pixellab-index.mjs';

export const REUSE_THRESHOLD = 0.6;

// 플러그인 루트(= 이 스크립트의 상위 디렉터리). standalone·설치형 모두 <root>/scripts/ 아래라 동일 해석.
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STOPWORDS = new Set('a an the with and or of for to in on at is are be as by from into over under single centered object icon pixel art game rpg inventory transparent background clean vibrant bold dark outline'.split(/\s+/));

// ── 어휘 유사도(원본 로직 유지) ────────────────────────────────────────────
export function tokenize(s) {
  return (s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w.length > 1 && !STOPWORDS.has(w));
}
// 태그 전용 토큰화(FTS 인덱스/질의 정렬용, 계획 §9.3 MAJ-1):
//   - STOPWORD 미적용(`dark`,`outline` 등 의미있는 태그 보존).
//   - `[^a-z0-9]` 제거(FTS 특수문자 주입 차단 + `grade:C` → ['grade','c'] 분해).
//   - 길이 1 이상 유지(단일 문자 태그 토큰도 색인).
export function tokenizeTag(s) {
  return String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 1);
}
function jaccard(aArr, bArr) {
  const a = new Set(aArr), b = new Set(bArr);
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function overlapRatio(aArr, bArr) {
  const a = new Set(aArr), b = new Set(bArr);
  if (a.size === 0) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / a.size;
}
// prompt 유사도 = 대칭 Jaccard(전반 유사)와 질의 포함도(짧은 질의가 캐시 설명의 부분집합이면 高)의 평균.
function blendSim(aArr, bArr) { return 0.5 * jaccard(aArr, bArr) + 0.5 * overlapRatio(aArr, bArr); }

// ── 메타 스키마 v2 접근자(v1 하위호환) ─────────────────────────────────────
export function entryView(e) { return (e.style && e.style.view) != null ? e.style.view : e.view; }
export function entryAnchor(e) { return (e.style && e.style.anchor) != null ? e.style.anchor : e.anchor; }
export function entrySize(e) { return (e.style && e.style.size) != null ? e.style.size : e.size; }
export function entryTool(e) { return (e.style && e.style.tool) != null ? e.style.tool : e.tool; }
export function entryFile(e) { return (e.files && e.files[0]) || e.file || (e.id + '.png'); }

export function score(query, entry) {
  const qTok = tokenize(query.prompt), eTok = tokenize(entry.prompt);
  const qTags = (query.tags || []).map((t) => String(t).toLowerCase());
  const eTags = (entry.tags || []).map((t) => String(t).toLowerCase());
  const promptSim = blendSim(qTok, eTok);
  // 질의에 태그가 있을 때만 태그 신호를 섞는다(없으면 구조적 태그로 감점되지 않도록).
  let s = qTags.length ? (0.7 * promptSim + 0.3 * overlapRatio(qTags, eTags)) : promptSim;
  // 스타일 보정(맞으면 소폭 가산, 다르면 소폭 감산 — 완전 배제는 --style-strict 로).
  const ev = entryView(entry), es = entrySize(entry), et = entryTool(entry);
  if (query.view && ev) s += (query.view === ev) ? 0.05 : -0.05;
  if (query.size && es != null) s += (Math.abs(Number(query.size) - Number(es)) <= 8) ? 0.03 : -0.03;
  if (query.tool && et) s += (query.tool === et) ? 0.02 : -0.02;
  // 스타일 앵커: 같은 앵커로 만든 세트끼리 어울린다 — 일치 가산/불일치 감산(배제는 --style-strict).
  const ea = entryAnchor(entry);
  if (query.anchor && ea) s += (query.anchor === ea) ? 0.05 : -0.05;
  return Math.max(0, Math.min(1, s));
}

function styleCompatible(query, entry) {
  const ev = entryView(entry), es = entrySize(entry), et = entryTool(entry), ea = entryAnchor(entry);
  if (query.view && ev && query.view !== ev) return false;
  if (query.tool && et && query.tool !== et) return false;
  if (query.size && es != null && Math.abs(Number(query.size) - Number(es)) > 16) return false;
  if (query.anchor && ea && query.anchor !== ea) return false;
  return true;
}

// ── 캐시 루트 해석/입출력 ───────────────────────────────────────────────────
export function resolveRoots(env = process.env) {
  // 전역 라이브러리는 플러그인 repo 안(library/)에 둔다 — git 으로 버전관리·push 되어
  // 현재/미래 생성 이미지가 repo 에 함께 올라가고, 다른 기기·설치형은 pull 로 공유한다.
  // standalone·설치형 모두 <PLUGIN_ROOT>/library 로 동일 해석. 위치 변경은 PIXELLAB_CACHE_GLOBAL 로만.
  const global = env.PIXELLAB_CACHE_GLOBAL
    || path.join(PLUGIN_ROOT, 'library');
  const project = env.PIXELLAB_CACHE_PROJECT
    || (env.CLAUDE_PROJECT_DIR ? path.join(env.CLAUDE_PROJECT_DIR, '.pixellab-cache')
      : path.join(process.cwd(), '.pixellab-cache'));
  return { global, project };
}
function rootPaths(root) {
  return { index: path.join(root, 'index.json'), images: path.join(root, 'images') };
}
export function loadIndex(root) {
  const { index } = rootPaths(root);
  if (!existsSync(index)) return { _doc: 'PixelLab 재사용 캐시 대장', version: 2, reuseThreshold: REUSE_THRESHOLD, entries: [] };
  try {
    const idx = JSON.parse(readFileSync(index, 'utf8'));
    if (!Array.isArray(idx.entries)) idx.entries = [];
    return idx;
  } catch (e) { throw new Error(`index.json 파싱 오류 (${index}): ${e.message}`); }
}
function saveIndex(root, idx) {
  mkdirSync(root, { recursive: true });
  writeFileSync(rootPaths(root).index, JSON.stringify(idx, null, 2));
}
export function hashFile(file) {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}
export function absImagePath(entry, roots) {
  const root = entry.scope === 'project' ? roots.project : roots.global;
  return path.join(root, 'images', entryFile(entry));
}

// project → global 병합(id 중복 시 project 우선). 각 entry 에 scope 부여.
export function loadMergedEntries(roots) {
  const proj = loadIndex(roots.project).entries.map((e) => ({ ...e, scope: 'project' }));
  const glob = loadIndex(roots.global).entries.map((e) => ({ ...e, scope: 'global' }));
  const seen = new Set(proj.map((e) => e.id));
  const merged = proj.slice();
  for (const e of glob) if (!seen.has(e.id)) merged.push(e);
  return merged;
}

// 현 알고리즘 보존 — 회귀 등가(ground truth) 기준. 전량 로드 + 전 항목 선형 score().
// (검색 핫패스는 findMatches 가 담당하고, 이건 셀프테스트 e/k 회귀 비교 및 폴백 참조용.)
export function findMatchesLinear(query, roots, opts = {}) {
  const top = opts.top || 5;
  const styleStrict = !!opts.styleStrict;
  let entries = loadMergedEntries(roots);
  if (styleStrict) entries = entries.filter((e) => styleCompatible(query, e));
  const ranked = entries.map((e) => {
    let s = score(query, e);
    if (query.contentHash && e.contentHash && e.contentHash === query.contentHash) s = 1; // 정확 중복
    return { e, s };
  }).sort((x, y) => y.s - x.s).slice(0, top);
  return ranked;
}

// 검색 핫패스: FTS5 온디스크 역색인으로 후보를 매칭-집합으로 추린 뒤, 기존 score() 로만 재랭킹.
// - AC-2: loadMergedEntries(전량 파싱) 미호출. 신선한 인덱스에서 index.json 미독(stat/sha 만).
// - 후보 = 각 root(project→global) 매칭-집합 병합·dedup(project 우선) → styleStrict 필터 → score()+contentHash=1.
// - 백엔드 부재 시 BackendUnavailableError 전파(CLI 는 잡아 명확 에러, 훅은 잡아 degrade).
// - opts.allowRebuild: CLI=true(기본, stale/부재 시 rebuild), 훅=false(rebuild 금지, 부재 시 skip).
export function findMatches(query, roots, opts = {}) {
  const top = opts.top || 5;
  const styleStrict = !!opts.styleStrict;
  const allowRebuild = opts.allowRebuild ?? true;
  const kMax = opts.candidateK || Number(process.env.PIXELLAB_CANDIDATE_K) || 5000;
  const collect = (root, scope) => {
    // 원본(index.json)도 인덱스(.sqlite)도 없는 root 는 부작용 없이 건너뛴다(빈 project 캐시에 파일 생성 방지).
    if (!existsSync(path.join(root, 'index.json')) && !existsSync(path.join(root, 'index.sqlite'))) return { cands: [], ids: [] };
    const fr = ensureFresh(root, { allowRebuild }); // 백엔드 부재 시 throw
    if (!fr.fresh) return { cands: [], ids: [] }; // 훅(allowRebuild:false)에서 stale/부재 → 후보 조회 skip
    const cands = getCandidates(root, query, kMax).map((e) => ({ ...e, scope }));
    // project 는 전체 id 도 필요(override 억제용 — 아래 참조). global 은 후보만 필요.
    const ids = scope === 'project' ? allIds(root) : [];
    return { cands, ids };
  };
  const proj = collect(roots.project, 'project');
  const glob = collect(roots.global, 'global');
  // dedup: findMatchesLinear(loadMergedEntries) 와 동일 의미 — "project 전체 id" 로 global 을 억제한다(project 우선).
  // project override 가 질의 토큰과 안 겹쳐 후보(proj.cands)에 없더라도, 그 id 의 global 원본은
  // 부활시키지 않는다(억제만 — HIGH 회귀: 후보 id 로만 seen 을 채우면 override 미매칭 시 global 이 부활한다).
  const seen = new Set(proj.ids);
  const candidates = proj.cands.slice();
  for (const e of glob.cands) if (!seen.has(e.id)) candidates.push(e);
  let ents = candidates;
  if (styleStrict) ents = ents.filter((e) => styleCompatible(query, e));
  const ranked = ents.map((e) => {
    let s = score(query, e);
    if (query.contentHash && e.contentHash && e.contentHash === query.contentHash) s = 1; // 정확 중복
    return { e, s };
  }).sort((x, y) => y.s - x.s).slice(0, top);
  return ranked;
}

// ── 등록(코어) ──────────────────────────────────────────────────────────────
function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length ? out : undefined;
}
/**
 * addEntry(root, opts) — 파일을 root/images 로 복사하고 메타를 index.json 에 upsert.
 * opts: { id, prompt, file, scope, tags[], size, view, tool, palette, outline,
 *         assetType, pixellabObjectId, frameIndex, sprites[], license{license,author,source}, createdAt }
 * 반환: { entry, duplicateOf, total } — duplicateOf 는 동일 contentHash 를 가진 기존 항목 id(다른 id).
 */
export function addEntry(root, opts) {
  if (!opts.id || !opts.prompt || !opts.file) throw new Error('addEntry 필수: id, prompt, file');
  if (!existsSync(opts.file)) throw new Error(`파일 없음: ${opts.file}`);
  const idx = loadIndex(root);
  const contentHash = hashFile(opts.file);
  const dup = idx.entries.find((e) => e.contentHash && e.contentHash === contentHash && e.id !== opts.id);
  const images = rootPaths(root).images;
  mkdirSync(images, { recursive: true });
  const destName = opts.id + '.png';
  copyFileSync(opts.file, path.join(images, destName));
  const entry = {
    id: opts.id,
    prompt: opts.prompt,
    style: compact({
      size: opts.size != null ? Number(opts.size) : undefined,
      view: opts.view || undefined,
      palette: opts.palette || undefined,
      outline: opts.outline || undefined,
      tool: opts.tool || undefined,
      anchor: opts.anchor || undefined,
    }),
    tags: opts.tags || [],
    assetType: opts.assetType || undefined,
    pixellabObjectId: opts.pixellabObjectId || undefined,
    frameIndex: opts.frameIndex != null ? Number(opts.frameIndex) : undefined,
    sprites: opts.sprites && opts.sprites.length ? opts.sprites : undefined,
    files: [destName],
    license: compact({
      license: opts.license && opts.license.license || undefined,
      author: opts.license && opts.license.author || undefined,
      source: opts.license && opts.license.source || undefined,
    }),
    contentHash,
    createdAt: opts.createdAt || 'unknown',
    scope: opts.scope || undefined,
  };
  // undefined 키 정리
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  const at = idx.entries.findIndex((e) => e.id === opts.id);
  if (at >= 0) idx.entries[at] = entry; else idx.entries.push(entry);
  saveIndex(root, idx);
  return { entry, duplicateOf: dup ? dup.id : null, total: idx.entries.length };
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
function relToCwd(p) { return path.relative(process.cwd(), p).replace(/\\/g, '/') || p; }

function cmdInit() {
  const roots = resolveRoots();
  for (const [name, root] of [['global', roots.global], ['project', roots.project]]) {
    mkdirSync(rootPaths(root).images, { recursive: true });
    if (!existsSync(rootPaths(root).index)) saveIndex(root, loadIndex(root));
    console.log(`${name.padEnd(8)} ${root}`);
  }
  console.log(`임계값 REUSE_THRESHOLD = ${REUSE_THRESHOLD}`);
  console.log('초기화 완료.');
}

function cmdConfig() {
  const roots = resolveRoots();
  console.log('PixelLab Forge 캐시 설정');
  console.log('─'.repeat(60));
  console.log(`REUSE_THRESHOLD   ${REUSE_THRESHOLD}`);
  console.log(`global  cache     ${roots.global}`);
  console.log(`project cache     ${roots.project}`);
  console.log('─'.repeat(60));
  console.log('환경변수(설정 시 우선):');
  console.log(`  PIXELLAB_CACHE_GLOBAL  = ${process.env.PIXELLAB_CACHE_GLOBAL || '(미설정)'}`);
  console.log(`  PIXELLAB_CACHE_PROJECT = ${process.env.PIXELLAB_CACHE_PROJECT || '(미설정)'}`);
  console.log(`  CLAUDE_PLUGIN_DATA     = ${process.env.CLAUDE_PLUGIN_DATA || '(미설정)'}`);
  console.log(`  CLAUDE_PROJECT_DIR     = ${process.env.CLAUDE_PROJECT_DIR || '(미설정)'}`);
  const g = loadIndex(roots.global).entries.length;
  const p = loadIndex(roots.project).entries.length;
  console.log(`항목 수: global ${g}개, project ${p}개`);
}

function cmdFind(args) {
  const roots = resolveRoots();
  const query = {
    prompt: args._[0] || '',
    tags: args.tags ? String(args.tags).split(',') : [],
    view: args.view && args.view !== 'true' ? args.view : undefined,
    size: args.size && args.size !== 'true' ? Number(args.size) : undefined,
    tool: args.tool && args.tool !== 'true' ? args.tool : undefined,
    anchor: args.anchor && args.anchor !== 'true' ? args.anchor : undefined,
    contentHash: (args.file && args.file !== 'true' && existsSync(args.file)) ? hashFile(args.file) : undefined,
  };
  if (!query.prompt && query.tags.length === 0 && !query.contentHash) {
    console.error('사용법: find "<설명>" [--tags a,b] [--view sidescroller] [--size 42] [--tool ...] [--anchor <앵커이름>] [--file ref.png] [--style-strict] [--top N]');
    process.exit(1);
  }
  let ranked;
  try {
    ranked = findMatches(query, roots, { top: Number(args.top || 5), styleStrict: args['style-strict'] === 'true' });
  } catch (e) {
    if (e instanceof BackendUnavailableError) { console.error(backendHint()); process.exit(1); }
    throw e;
  }
  console.log(`질의: "${query.prompt}"${query.tags.length ? ' tags=[' + query.tags.join(',') + ']' : ''}${query.view ? ' view=' + query.view : ''}${query.size ? ' size=' + query.size : ''}${query.anchor ? ' anchor=' + query.anchor : ''}`);
  console.log('─'.repeat(60));
  if (ranked.length === 0) {
    // 후보 매칭 0건(질의 토큰과 겹치는 항목 없음) = 판정상 "신규 생성"과 등가.
    console.log('🆕 신규 생성 권장: 질의와 겹치는 캐시 후보 없음 (충분히 유사한 캐시 없음)');
    console.log('   생성 후 반드시 add 로 등록:');
    console.log(`   node "<plugin>/scripts/pixellab-cache.mjs" add --id <새id> --prompt "${query.prompt}" --file <생성png> [--scope global|project]`);
    return;
  }
  for (const { e, s } of ranked) {
    const abs = absImagePath(e, roots);
    console.log(`${s.toFixed(2)}  [${e.scope}]  ${e.id}  {${(e.tags || []).slice(0, 6).join(', ')}}`);
    console.log(`      prompt: ${e.prompt}`);
    console.log(`      file:   ${relToCwd(abs)}  size:${entrySize(e) ?? '?'} view:${entryView(e) || '?'}`);
  }
  console.log('─'.repeat(60));
  const best = ranked[0];
  if (best.s >= REUSE_THRESHOLD) {
    const abs = absImagePath(best.e, roots);
    const exact = query.contentHash && best.e.contentHash === query.contentHash;
    console.log(`✅ 재사용 권장: score ${best.s.toFixed(2)} ≥ ${REUSE_THRESHOLD}${exact ? ' (정확 중복 — 동일 파일)' : ''} [${best.e.scope}]`);
    console.log(`   → ${abs}`);
    console.log(`     이 파일을 그대로 쓰거나 대상 위치로 복사. PixelLab 호출 불필요(비용 0).`);
  } else {
    console.log(`🆕 신규 생성 권장: 최고 score ${best.s.toFixed(2)} < ${REUSE_THRESHOLD} (충분히 유사한 캐시 없음)`);
    console.log(`   생성 후 반드시 add 로 등록:`);
    console.log(`   node "<plugin>/scripts/pixellab-cache.mjs" add --id <새id> --prompt "${query.prompt}" --file <생성png> [--scope global|project]`);
  }
}

function cmdList(args) {
  const roots = resolveRoots();
  let entries = loadMergedEntries(roots);
  const scope = args.scope && args.scope !== 'true' ? args.scope : null;
  if (scope) entries = entries.filter((e) => e.scope === scope);
  const filterTags = args.tags ? String(args.tags).split(',').map((t) => t.toLowerCase()) : null;
  if (filterTags) entries = entries.filter((e) => filterTags.every((t) => (e.tags || []).map((x) => String(x).toLowerCase()).includes(t)));
  console.log(`캐시 항목 ${entries.length}개${scope ? ' scope=' + scope : ''}${filterTags ? ' tags=' + filterTags.join(',') : ''}:`);
  for (const e of entries) console.log(`  [${e.scope.padEnd(7)}] ${e.id.padEnd(24)} ${(e.tags || []).slice(0, 5).join(',')}`);
}

function cmdGet(args) {
  const roots = resolveRoots();
  const id = args._[0];
  const e = loadMergedEntries(roots).find((x) => x.id === id);
  if (!e) { console.error(`없음: ${id}`); process.exit(1); }
  console.log(JSON.stringify({ ...e, _imagePath: absImagePath(e, roots) }, null, 2));
}

function cmdAdd(args) {
  if (!args.id || !args.prompt || !args.file) { console.error('필수: --id --prompt --file'); process.exit(1); }
  const roots = resolveRoots();
  const scope = args.scope === 'project' ? 'project' : 'global'; // 기본 global(전역 라이브러리)
  const root = scope === 'project' ? roots.project : roots.global;
  // add 는 백엔드 필수(CLI 계약). ensureFresh 로 (add 前) index.json 과 동기화 — 이후 upsertOne 이 O(1) 증분.
  try {
    ensureFresh(root, { allowRebuild: true });
  } catch (e) {
    if (e instanceof BackendUnavailableError) { console.error(backendHint()); process.exit(1); }
    throw e;
  }
  const res = addEntry(root, {
    id: args.id,
    prompt: args.prompt,
    file: args.file,
    scope,
    tags: args.tags ? String(args.tags).split(',') : [],
    size: (args.size && args.size !== 'true') ? Number(args.size) : undefined,
    view: (args.view && args.view !== 'true') ? args.view : undefined,
    tool: (args.tool && args.tool !== 'true') ? args.tool : 'create_1_direction_object',
    anchor: (args.anchor && args.anchor !== 'true') ? args.anchor : undefined,
    palette: (args.palette && args.palette !== 'true') ? args.palette : undefined,
    outline: (args.outline && args.outline !== 'true') ? args.outline : undefined,
    assetType: (args.type && args.type !== 'true') ? args.type : undefined,
    pixellabObjectId: (args['object-id'] && args['object-id'] !== 'true') ? args['object-id'] : undefined,
    frameIndex: (args.frame != null && args.frame !== 'true') ? Number(args.frame) : undefined,
    sprites: args.sprites ? String(args.sprites).split(',') : undefined,
    license: {
      license: (args.license && args.license !== 'true') ? args.license : undefined,
      author: (args.author && args.author !== 'true') ? args.author : undefined,
      source: (args.source && args.source !== 'true') ? args.source : undefined,
    },
    createdAt: (args.date && args.date !== 'true') ? args.date : undefined,
  });
  upsertOne(root, res.entry); // O(1) 증분 갱신 + meta 시그니처 재동기화(다음 find 가 rebuild 안 하도록)
  console.log(`등록[${scope}]: ${args.id} → ${path.join(root, 'images', args.id + '.png')} (해당 scope 총 ${res.total}개)`);
  if (res.duplicateOf) console.log(`⚠️ 동일 contentHash 기존 항목 존재: ${res.duplicateOf} (정확 중복 — 재사용 검토)`);
}

function cmdPrune() {
  const roots = resolveRoots();
  let totalRemoved = 0, totalBytes = 0;
  for (const [name, root] of [['global', roots.global], ['project', roots.project]]) {
    const { images } = rootPaths(root);
    const idx = loadIndex(root);
    const before = idx.entries.length;
    const removedIds = idx.entries.filter((e) => !existsSync(path.join(images, entryFile(e)))).map((e) => e.id);
    idx.entries = idx.entries.filter((e) => existsSync(path.join(images, entryFile(e))));
    const removed = before - idx.entries.length;
    if (removed > 0) {
      saveIndex(root, idx);
      // 인덱스에서도 제거 id 만 증분 삭제(§9.7). 백엔드 부재면 index.json 이 진실 — 다음 find 가 rebuild.
      try { removeIds(root, removedIds); } catch (e) { if (!(e instanceof BackendUnavailableError)) throw e; }
    }
    totalRemoved += removed;
    let bytes = 0;
    if (existsSync(images)) for (const f of readdirSync(images)) { try { bytes += statSync(path.join(images, f)).size; } catch { /* skip */ } }
    totalBytes += bytes;
    console.log(`[${name}] 항목 ${idx.entries.length}개(정리 ${removed}), images ${(bytes / 1024).toFixed(1)} KB — ${root}`);
  }
  console.log(`합계: 정리 ${totalRemoved}개, 총 용량 ${(totalBytes / 1024).toFixed(1)} KB`);
}

// ── 재사용 인덱스 백엔드(better-sqlite3) 배선 ────────────────────────────────
function backendHint() {
  const cli = path.join(PLUGIN_ROOT, 'scripts', 'pixellab-cache.mjs');
  return [
    'better-sqlite3(재사용 인덱스 백엔드)가 설치되어 있지 않습니다.',
    `  setup 실행:  node "${cli}" setup`,
    `  수동 설치:   cd "${PLUGIN_ROOT}" && npm install`,
  ].join('\n');
}

// setup — better-sqlite3 설치 보장. 자동 npm install 은 이 명령에서만(find/add/훅 은 절대 자동설치 X, §OQ4).
function cmdSetup() {
  const require = createRequire(import.meta.url);
  try {
    require.resolve('better-sqlite3');
    console.log('better-sqlite3 이미 설치됨.');
    // FTS5/동작 스모크
    try {
      rebuildIndex(resolveRoots().global);
      console.log('전역 인덱스 rebuild 확인 완료(FTS5 동작).');
    } catch (e) { console.log(`(인덱스 rebuild 스모크 생략: ${e.message})`); }
    process.exit(0);
  } catch { /* 미설치 → 아래에서 설치 시도 */ }
  console.log(`better-sqlite3 미설치 → npm install 실행 (${PLUGIN_ROOT}) ...`);
  const r = spawnSync('npm', ['install', '--omit=dev'], { cwd: PLUGIN_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status === 0) {
    console.log('설치 완료. 이제 find/add 가 재사용 인덱스를 사용합니다.');
    process.exit(0);
  }
  console.error('자동 설치 실패.');
  console.error(`수동 설치: cd "${PLUGIN_ROOT}" && npm install`);
  console.error('(prebuild 부재 플랫폼이면 빌드 툴체인[python/C++ toolchain]이 필요할 수 있습니다.)');
  process.exit(1);
}

// rebuild | reindex — 두 root 인덱스를 index.json 전량으로 재구성.
function cmdRebuild() {
  const roots = resolveRoots();
  try {
    for (const [name, root] of [['global', roots.global], ['project', roots.project]]) {
      if (!existsSync(rootPaths(root).index)) { console.log(`${name.padEnd(8)} (index.json 없음 — 건너뜀) ${root}`); continue; }
      rebuildIndex(root);
      console.log(`${name.padEnd(8)} 인덱스 재구성 완료 (${loadIndex(root).entries.length}개) ${path.join(root, 'index.sqlite')}`);
    }
  } catch (e) {
    if (e instanceof BackendUnavailableError) { console.error(backendHint()); process.exit(1); }
    throw e;
  }
}

// ── 셀프테스트(결정적, os.tmpdir 격리) ──────────────────────────────────────
// 1x1 투명 PNG(base64) — 실제 유효 PNG 바이트.
const SAMPLE_PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
function selftest() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pixellab-forge-selftest-'));
  const roots = { global: path.join(tmp, 'global'), project: path.join(tmp, 'project') };
  const pngA = path.join(tmp, 'a.png');
  const pngB = path.join(tmp, 'b.png');
  writeFileSync(pngA, SAMPLE_PNG_A);
  writeFileSync(pngB, Buffer.concat([SAMPLE_PNG_A, Buffer.from([0x42])])); // 다른 바이트 → 다른 해시
  // 서브루트 격리(케이스 간 오염 방지) + 고유 PNG(고유 contentHash) 생성기.
  let pngSeq = 0;
  const subRoots = (name) => ({ global: path.join(tmp, name, 'global'), project: path.join(tmp, name, 'project') });
  const mkPng = () => { const p = path.join(tmp, `p${pngSeq++}.png`); writeFileSync(p, Buffer.concat([SAMPLE_PNG_A, Buffer.from([pngSeq & 0xff, (pngSeq >> 8) & 0xff])])); return p; };
  // findMatches ≡ findMatchesLinear 등가 비교(계획 AC-1: score>0.10 후보집합·순서·판정·best 일치).
  const equiv = (query, r) => {
    const a = findMatches(query, r, { top: 999 });
    const b = findMatchesLinear(query, r, { top: 999 });
    const key = (arr) => arr.filter((x) => x.s > 0.10).map((x) => `${x.e.scope}:${x.e.id}:${x.s.toFixed(6)}`);
    const ka = JSON.stringify(key(a)), kb = JSON.stringify(key(b));
    const decA = !!(a.length && a[0].s >= REUSE_THRESHOLD), decB = !!(b.length && b[0].s >= REUSE_THRESHOLD);
    const bestA = a.length ? `${a[0].e.id}:${a[0].s.toFixed(6)}` : 'none';
    const bestB = b.length ? `${b[0].e.id}:${b[0].s.toFixed(6)}` : 'none';
    // best 비교는 s>0.10 일 때만(≤0.10 near-zero best 는 등가 범위 밖 — 스타일보정 바닥).
    const bestEq = ((a[0] && a[0].s > 0.10) || (b[0] && b[0].s > 0.10)) ? (bestA === bestB) : true;
    return { setEq: ka === kb, decEq: decA === decB, bestEq, bestA, bestB, ka, kb };
  };
  try {
    addEntry(roots.global, {
      scope: 'global', id: 'eq_workspace_C',
      prompt: 'a simple wooden office desk with a small computer monitor',
      file: pngA, tags: ['equipment', 'desk'], view: 'sidescroller', size: 42, tool: 'create_1_direction_object',
    });
    // (a) 유사 설명 → ≥ 0.6 재사용 (FTS 경로)
    const rA = findMatches({ prompt: 'a wooden desk with a monitor', tags: [] }, roots, {});
    ok('a) 유사설명 재사용(≥0.6)', rA.length && rA[0].s >= REUSE_THRESHOLD, `score=${rA[0] && rA[0].s.toFixed(3)}`);
    // (b) 무관 설명 → < 0.6 신규
    const rB = findMatches({ prompt: 'a steel sword and shield', tags: [] }, roots, {});
    ok('b) 무관설명 신규(<0.6)', !rB.length || rB[0].s < REUSE_THRESHOLD, `score=${rB[0] ? rB[0].s.toFixed(3) : 'none'}`);
    // (c) 동일 파일 재add → contentHash 로 정확 중복 감지
    const dupRes = addEntry(roots.global, { scope: 'global', id: 'eq_workspace_C_copy', prompt: 'another desk variant', file: pngA });
    ok('c1) 재add 정확중복 감지', dupRes.duplicateOf === 'eq_workspace_C', `duplicateOf=${dupRes.duplicateOf}`);
    // (c2) find --file(=contentHash) → score 1.0 (무관 prompt 라도 hash 후보 강제 편입)
    const rC = findMatches({ prompt: 'totally unrelated text here', contentHash: hashFile(pngA) }, roots, {});
    ok('c2) find(hash) 정확중복 score=1.0', rC.length && rC[0].s === 1, `score=${rC[0] && rC[0].s}`);
    // (d) 하이브리드: 같은 id 가 project·global 양쪽 → project 우선
    addEntry(roots.global, { scope: 'global', id: 'dup', prompt: 'global version of dup', file: pngB });
    addEntry(roots.project, { scope: 'project', id: 'dup', prompt: 'project version of dup', file: pngB });
    const dupEntries = loadMergedEntries(roots).filter((e) => e.id === 'dup');
    ok('d) 하이브리드 project 우선', dupEntries.length === 1 && dupEntries[0].scope === 'project', `scopes=[${dupEntries.map((e) => e.scope).join(',')}]`);

    // (e) 회귀 등가: findMatches ≡ findMatchesLinear (다양한 항목 + 질의 배터리)
    const rE = subRoots('e');
    addEntry(rE.global, { scope: 'global', id: 'desk', prompt: 'a simple wooden office desk with a small computer monitor', file: mkPng(), tags: ['equipment', 'desk'], view: 'sidescroller', size: 42 });
    addEntry(rE.global, { scope: 'global', id: 'sword', prompt: 'a sharp steel sword with a leather grip', file: mkPng(), tags: ['weapon', 'sword'], view: 'sidescroller', size: 42 });
    addEntry(rE.global, { scope: 'global', id: 'chair', prompt: 'a wooden office chair with wheels', file: mkPng(), tags: ['equipment', 'chair'], view: 'sidescroller', size: 42 });
    addEntry(rE.project, { scope: 'project', id: 'desk', prompt: 'a modern glass office desk with a monitor', file: mkPng(), tags: ['equipment', 'desk'], view: 'sidescroller', size: 42 }); // project override
    const battery = [
      { prompt: 'a wooden desk with a monitor', tags: [] },
      { prompt: 'a steel sword', tags: [] },
      { prompt: 'office chair wooden', tags: ['equipment'] },
      { prompt: '', tags: ['desk'] },
      { prompt: 'nonexistent gibberish qwxz', tags: [] },
      { prompt: 'a wooden office desk', tags: ['equipment', 'desk'], view: 'sidescroller', size: 42 },
    ];
    let eAll = true, eDetail = `${battery.length} 질의 등가`;
    for (const q of battery) {
      const c = equiv(q, rE);
      if (!(c.setEq && c.decEq && c.bestEq)) { eAll = false; eDetail = `q="${q.prompt}"|set${c.setEq}dec${c.decEq}best${c.bestEq}|fm=${c.ka}|lin=${c.kb}`; break; }
    }
    ok('e) 회귀 등가(findMatches≡findMatchesLinear)', eAll, eDetail);

    // (f) db 삭제 → 다음 find 자동 rebuild
    const rF = subRoots('f');
    addEntry(rF.global, { scope: 'global', id: 'desk', prompt: 'a wooden office desk', file: mkPng(), tags: ['desk'] });
    findMatches({ prompt: 'wooden desk', tags: [] }, rF, {}); // 최초 build
    closeAll();
    for (const suf of ['', '-wal', '-shm']) { try { rmSync(path.join(rF.global, 'index.sqlite' + suf), { force: true }); } catch { /* ignore */ } }
    const frF = ensureFresh(rF.global, { allowRebuild: true });
    const rf2 = findMatches({ prompt: 'wooden desk', tags: [] }, rF, {});
    ok('f) db 삭제 후 자동 rebuild', frF.rebuilt === true && rf2.length && rf2[0].e.id === 'desk', `rebuilt=${frF.rebuilt}`);

    // (g) staleness: 내용변경 → rebuild, git mtime churn(내용 동일) → rebuild 생략
    const rG = subRoots('g');
    addEntry(rG.global, { scope: 'global', id: 'a', prompt: 'a wooden office desk', file: mkPng(), tags: ['desk'] });
    ensureFresh(rG.global, { allowRebuild: true });
    const frG1 = ensureFresh(rG.global, { allowRebuild: true }); // 이미 신선
    addEntry(rG.global, { scope: 'global', id: 'b', prompt: 'a steel sword blade', file: mkPng(), tags: ['sword'] }); // index.json 내용 변경(직접 addEntry — db 미갱신)
    const frG2 = ensureFresh(rG.global, { allowRebuild: true }); // 내용 변경 → rebuild
    const idxPathG = path.join(rG.global, 'index.json');
    const future = new Date(Date.now() + 5000);
    utimesSync(idxPathG, future, future); // mtime 만 변경(내용/ sha 동일)
    const frG3 = ensureFresh(rG.global, { allowRebuild: true }); // churn → rebuild 생략
    ok('g) staleness(내용변경 rebuild / mtime churn 생략)',
      frG1.rebuilt === false && frG2.rebuilt === true && frG3.rebuilt === false && frG3.reason === 'mtime-churn',
      `fr1=${frG1.rebuilt} fr2=${frG2.rebuilt} fr3=${frG3.rebuilt}/${frG3.reason}`);

    // (h) 증분: cmdAdd 흐름(ensureFresh→addEntry→upsertOne) 후 find 가 rebuild 미발생 + 신항목 검색
    const rH = subRoots('h');
    addEntry(rH.global, { scope: 'global', id: 'a', prompt: 'a wooden office desk', file: mkPng(), tags: ['desk'] });
    ensureFresh(rH.global, { allowRebuild: true }); // build
    ensureFresh(rH.global, { allowRebuild: true }); // (cmdAdd 前 동기화)
    const resH = addEntry(rH.global, { scope: 'global', id: 'b', prompt: 'a steel sword blade', file: mkPng(), tags: ['sword'] });
    upsertOne(rH.global, resH.entry);
    const frH = ensureFresh(rH.global, { allowRebuild: true }); // rebuild 미발생 기대
    const rh = findMatches({ prompt: 'steel sword', tags: [] }, rH, {});
    ok('h) 증분 upsert 후 rebuild 미발생 + 신항목 검색',
      frH.rebuilt === false && rh.length && rh[0].e.id === 'b',
      `rebuilt=${frH.rebuilt} best=${rh[0] && rh[0].e.id}`);

    // (i) 훅 degrade: 백엔드 부재/정상 모두 exit 0 (자식 프로세스로 cache-guard 실행)
    const cacheGuard = path.join(PLUGIN_ROOT, 'scripts', 'cache-guard.mjs');
    const payload = JSON.stringify({ tool_name: 'mcp__pixellab__create_character', tool_input: { description: 'a wooden office desk' } });
    const rI = subRoots('i');
    addEntry(rI.global, { scope: 'global', id: 'desk', prompt: 'a wooden office desk', file: mkPng(), tags: ['desk'] });
    findMatches({ prompt: 'wooden desk', tags: [] }, rI, {}); // db 신선하게
    closeAll(); // 자식이 같은 db 파일 열기 전에 부모 핸들 해제
    const envBase = { ...process.env, PIXELLAB_CACHE_GLOBAL: rI.global, PIXELLAB_CACHE_PROJECT: rI.project };
    const p1 = spawnSync(process.execPath, [cacheGuard], { input: payload, encoding: 'utf8', env: { ...envBase, PIXELLAB_FORCE_NO_BACKEND: '1' } });
    const p2 = spawnSync(process.execPath, [cacheGuard], { input: payload, encoding: 'utf8', env: envBase });
    ok('i) 훅 degrade 항상 exit 0(백엔드 부재/정상)', p1.status === 0 && p2.status === 0, `noBackend=${p1.status} backend=${p2.status}`);

    // (j) N>K_MAX 절단 경고 + 후보 ≤ K_MAX
    const rJ = subRoots('j');
    for (let i = 0; i < 6; i++) addEntry(rJ.global, { scope: 'global', id: 'sw' + i, prompt: `a steel sword number ${i}`, file: mkPng(), tags: ['sword'] });
    ensureFresh(rJ.global, { allowRebuild: true });
    let warnedJ = false;
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { if (String(s).includes('K_MAX')) warnedJ = true; return true; };
    let candJ;
    try { candJ = getCandidates(rJ.global, { prompt: 'steel sword', tags: ['sword'] }, 3); }
    finally { process.stderr.write = origWrite; }
    ok('j) N>K_MAX 절단 경고', warnedJ && candJ.length <= 3, `warned=${warnedJ} cand=${candJ && candJ.length}`);

    // (k) STOPWORD 태그(dark) 등가 + 포착 (tokenizeTag 로 후보에 포함)
    const rK = subRoots('k');
    addEntry(rK.global, { scope: 'global', id: 'darkitem', prompt: 'zzz totally distinct qwxyz descriptor', file: mkPng(), tags: ['dark', 'outline'] });
    addEntry(rK.global, { scope: 'global', id: 'other', prompt: 'a bright sunny meadow', file: mkPng(), tags: ['nature'] });
    ensureFresh(rK.global, { allowRebuild: true });
    const qK = { prompt: 'unrelated words here', tags: ['dark'] };
    const cK = equiv(qK, rK);
    const fmK = findMatches(qK, rK, { top: 5 });
    const hasDark = fmK.some((x) => x.e.id === 'darkitem');
    ok('k) STOPWORD 태그(dark) 등가+포착', cK.setEq && cK.decEq && cK.bestEq && hasDark, `set${cK.setEq} best=${cK.bestA}/${cK.bestB} hasDark=${hasDark}`);

    // (l) 태그 특수문자 주입 안전(크래시 없음)
    const rL = subRoots('l');
    addEntry(rL.global, { scope: 'global', id: 'foo', prompt: 'a foo bar widget', file: mkPng(), tags: ['foo', 'bar'] });
    ensureFresh(rL.global, { allowRebuild: true });
    let crashedL = false, resL;
    try { resL = findMatches({ prompt: 'widget', tags: ['foo"bar*', 'baz)OR(qux', '*'] }, rL, { top: 5 }); }
    catch { crashedL = true; }
    ok('l) 태그 특수문자 주입 안전', !crashedL && Array.isArray(resL), `crashed=${crashedL} n=${resL && resL.length}`);

    // (m) 회귀(HIGH): project override 가 질의 토큰과 안 겹쳐도 global 원본이 부활하면 안 됨(project 우선 억제).
    // 재현: global "hero"=질의와 정확히 겹침(높은 score), project override "hero"=질의와 전혀 안 겹침(낮은 score).
    // 버그였던 동작: seen 을 "project 후보(질의 매칭)id" 로만 채우면 project override 가 후보에 안 뜨므로
    // seen 이 비어 global "hero" 가 그대로 부활 → project 우선 의미 붕괴. 고친 동작: seen = project 전체 id.
    const rM = subRoots('m');
    addEntry(rM.global, { scope: 'global', id: 'hero', prompt: 'a brave knight with a shining sword and shield armor', file: mkPng(), tags: [] });
    addEntry(rM.project, { scope: 'project', id: 'hero', prompt: 'zzz custom reskinned totally different mage wizard qwxyz', file: mkPng(), tags: [] });
    const qM = { prompt: 'a brave knight with a shining sword and shield armor', tags: [] };
    const cM = equiv(qM, rM);
    const fmM = findMatches(qM, rM, { top: 5 });
    const noGlobalRevival = !fmM.some((x) => x.e.scope === 'global' && x.e.id === 'hero');
    const isNewDecision = !(fmM.length && fmM[0].s >= REUSE_THRESHOLD);
    ok('m) project override 비매칭 억제(회귀)',
      cM.setEq && cM.decEq && cM.bestEq && noGlobalRevival && isNewDecision,
      `set${cM.setEq} dec${cM.decEq} best=${cM.bestA}/${cM.bestB} noGlobalRevival=${noGlobalRevival} newDecision=${isNewDecision}`);

    // (n) 스타일 앵커: add(--anchor) 왕복 + 일치 가산/불일치 감산 + --style-strict 배제 + 등가
    const rN = subRoots('n');
    addEntry(rN.global, { scope: 'global', id: 'orb_a', prompt: 'a glowing magic orb with sparks', file: mkPng(), tags: [], anchor: 'game-alpha' });
    addEntry(rN.global, { scope: 'global', id: 'orb_b', prompt: 'a glowing magic orb with sparks', file: mkPng(), tags: [], anchor: 'game-beta' });
    ensureFresh(rN.global, { allowRebuild: true });
    const roundTrip = entryAnchor(loadIndex(rN.global).entries.find((e) => e.id === 'orb_a')) === 'game-alpha';
    const qN = { prompt: 'a glowing magic orb with sparks', tags: [], anchor: 'game-alpha' };
    const fmN = findMatches(qN, rN, { top: 5 });
    const boosted = fmN.length >= 2 && fmN[0].e.id === 'orb_a' && fmN[0].s > fmN[1].s; // 같은 prompt → 앵커 보정만으로 순위 갈림
    const fmNs = findMatches(qN, rN, { top: 5, styleStrict: true });
    const strictExcluded = fmNs.length === 1 && fmNs[0].e.id === 'orb_a';
    const cN = equiv(qN, rN);
    ok('n) 스타일 앵커(왕복+보정+strict 배제+등가)',
      roundTrip && boosted && strictExcluded && cN.setEq && cN.decEq && cN.bestEq,
      `roundTrip=${roundTrip} boosted=${boosted} strict=${strictExcluded} set${cN.setEq}dec${cN.decEq}best${cN.bestEq}`);
  } finally {
    try { closeAll(); } catch { /* ignore */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
    if (r.pass) passed++;
  }
  console.log('─'.repeat(60));
  console.log(`${passed}/${results.length} PASS`);
  if (passed !== results.length) process.exit(1);
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (cmd === 'test' || cmd === '--selftest' || args.selftest === 'true') return selftest();
  switch (cmd) {
    case 'init': return cmdInit();
    case 'find': return cmdFind(args);
    case 'list': return cmdList(args);
    case 'get': return cmdGet(args);
    case 'add': return cmdAdd(args);
    case 'config': return cmdConfig();
    case 'prune': return cmdPrune();
    case 'setup': return cmdSetup();
    case 'rebuild': case 'reindex': return cmdRebuild();
    default:
      console.log('PixelLab Forge 재사용 캐시. 명령: init | find | add | list | get | config | prune | setup | rebuild | test');
      console.log('  node scripts/pixellab-cache.mjs find "a wooden office desk" --view sidescroller --size 42 --anchor my-game');
      console.log('  node scripts/pixellab-cache.mjs add --id my_id --prompt "..." --file path.png --scope global --tags a,b --size 42 --view sidescroller --anchor my-game');
      console.log('  node scripts/pixellab-cache.mjs config');
      console.log(`  임계값 REUSE_THRESHOLD = ${REUSE_THRESHOLD}`);
  }
}

// 정션/심링크 경유 실행 지원: ESM 의 import.meta.url 은 실경로라 argv[1] 도 실경로로 비교해야 한다.
const isMain = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) main();

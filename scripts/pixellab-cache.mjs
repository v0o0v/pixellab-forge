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
 *   view/size/tool 일치 소폭 보정. --file 로 준 이미지의 contentHash 가 캐시와 같으면 score=1.0(정확 중복).
 *   (임베딩 없이 결정적 어휘 유사도 — 무npm. 정확 매칭이 아니라 후보 추천이다.)
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
  readdirSync, statSync, rmSync, mkdtempSync,
} from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export const REUSE_THRESHOLD = 0.6;

// 플러그인 루트(= 이 스크립트의 상위 디렉터리). standalone·설치형 모두 <root>/scripts/ 아래라 동일 해석.
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STOPWORDS = new Set('a an the with and or of for to in on at is are be as by from into over under single centered object icon pixel art game rpg inventory transparent background clean vibrant bold dark outline'.split(/\s+/));

// ── 어휘 유사도(원본 로직 유지) ────────────────────────────────────────────
export function tokenize(s) {
  return (s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w.length > 1 && !STOPWORDS.has(w));
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
  return Math.max(0, Math.min(1, s));
}

function styleCompatible(query, entry) {
  const ev = entryView(entry), es = entrySize(entry), et = entryTool(entry);
  if (query.view && ev && query.view !== ev) return false;
  if (query.tool && et && query.tool !== et) return false;
  if (query.size && es != null && Math.abs(Number(query.size) - Number(es)) > 16) return false;
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

export function findMatches(query, roots, opts = {}) {
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
    contentHash: (args.file && args.file !== 'true' && existsSync(args.file)) ? hashFile(args.file) : undefined,
  };
  if (!query.prompt && query.tags.length === 0 && !query.contentHash) {
    console.error('사용법: find "<설명>" [--tags a,b] [--view sidescroller] [--size 42] [--tool ...] [--file ref.png] [--style-strict] [--top N]');
    process.exit(1);
  }
  const ranked = findMatches(query, roots, { top: Number(args.top || 5), styleStrict: args['style-strict'] === 'true' });
  console.log(`질의: "${query.prompt}"${query.tags.length ? ' tags=[' + query.tags.join(',') + ']' : ''}${query.view ? ' view=' + query.view : ''}${query.size ? ' size=' + query.size : ''}`);
  console.log('─'.repeat(60));
  if (ranked.length === 0) { console.log('캐시가 비어 있음 → 신규 생성 필요(생성 후 add 로 등록)'); return; }
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
  const res = addEntry(root, {
    id: args.id,
    prompt: args.prompt,
    file: args.file,
    scope,
    tags: args.tags ? String(args.tags).split(',') : [],
    size: (args.size && args.size !== 'true') ? Number(args.size) : undefined,
    view: (args.view && args.view !== 'true') ? args.view : undefined,
    tool: (args.tool && args.tool !== 'true') ? args.tool : 'create_1_direction_object',
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
    idx.entries = idx.entries.filter((e) => existsSync(path.join(images, entryFile(e))));
    const removed = before - idx.entries.length;
    if (removed > 0) saveIndex(root, idx);
    totalRemoved += removed;
    let bytes = 0;
    if (existsSync(images)) for (const f of readdirSync(images)) { try { bytes += statSync(path.join(images, f)).size; } catch { /* skip */ } }
    totalBytes += bytes;
    console.log(`[${name}] 항목 ${idx.entries.length}개(정리 ${removed}), images ${(bytes / 1024).toFixed(1)} KB — ${root}`);
  }
  console.log(`합계: 정리 ${totalRemoved}개, 총 용량 ${(totalBytes / 1024).toFixed(1)} KB`);
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
  try {
    addEntry(roots.global, {
      scope: 'global', id: 'eq_workspace_C',
      prompt: 'a simple wooden office desk with a small computer monitor',
      file: pngA, tags: ['equipment', 'desk'], view: 'sidescroller', size: 42, tool: 'create_1_direction_object',
    });
    // (a) 유사 설명 → ≥ 0.6 재사용
    const rA = findMatches({ prompt: 'a wooden desk with a monitor', tags: [] }, roots, {});
    ok('a) 유사설명 재사용(≥0.6)', rA.length && rA[0].s >= REUSE_THRESHOLD, `score=${rA[0] && rA[0].s.toFixed(3)}`);
    // (b) 무관 설명 → < 0.6 신규
    const rB = findMatches({ prompt: 'a steel sword and shield', tags: [] }, roots, {});
    ok('b) 무관설명 신규(<0.6)', !rB.length || rB[0].s < REUSE_THRESHOLD, `score=${rB[0] ? rB[0].s.toFixed(3) : 'none'}`);
    // (c) 동일 파일 재add → contentHash 로 정확 중복 감지
    const dupRes = addEntry(roots.global, { scope: 'global', id: 'eq_workspace_C_copy', prompt: 'another desk variant', file: pngA });
    ok('c1) 재add 정확중복 감지', dupRes.duplicateOf === 'eq_workspace_C', `duplicateOf=${dupRes.duplicateOf}`);
    // (c2) find --file(=contentHash) → score 1.0
    const rC = findMatches({ prompt: 'totally unrelated text here', contentHash: hashFile(pngA) }, roots, {});
    ok('c2) find(hash) 정확중복 score=1.0', rC.length && rC[0].s === 1, `score=${rC[0] && rC[0].s}`);
    // (d) 하이브리드: 같은 id 가 project·global 양쪽 → project 우선
    addEntry(roots.global, { scope: 'global', id: 'dup', prompt: 'global version of dup', file: pngB });
    addEntry(roots.project, { scope: 'project', id: 'dup', prompt: 'project version of dup', file: pngB });
    const dupEntries = loadMergedEntries(roots).filter((e) => e.id === 'dup');
    ok('d) 하이브리드 project 우선', dupEntries.length === 1 && dupEntries[0].scope === 'project', `scopes=[${dupEntries.map((e) => e.scope).join(',')}]`);
  } finally {
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
    default:
      console.log('PixelLab Forge 재사용 캐시. 명령: init | find | add | list | get | config | prune | test');
      console.log('  node scripts/pixellab-cache.mjs find "a wooden office desk" --view sidescroller --size 42');
      console.log('  node scripts/pixellab-cache.mjs add --id my_id --prompt "..." --file path.png --scope global --tags a,b --size 42 --view sidescroller');
      console.log('  node scripts/pixellab-cache.mjs config');
      console.log(`  임계값 REUSE_THRESHOLD = ${REUSE_THRESHOLD}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

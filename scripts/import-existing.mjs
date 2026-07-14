#!/usr/bin/env node
/**
 * scripts/import-existing.mjs — 기존 pixellab-cache(index.json + images/)를 Forge 캐시로 임포트
 *
 * 용도: tinyrich 등에서 이미 만든 재사용 캐시(예: tools/pixellab-cache/)의 항목들을
 *       Forge 하이브리드 캐시(기본 global 라이브러리)로 일괄 가져온다.
 *
 * 사용법:
 *   node scripts/import-existing.mjs --from <디렉터리> [--scope global|project] [--dry-run]
 *
 *   --from <dir>   기존 캐시 디렉터리. <dir>/index.json + <dir>/images/<file> 구조여야 한다.
 *   --scope        임포트 대상 scope(기본 global — 전역 라이브러리).
 *   --dry-run      실제 복사/등록 없이 어떤 항목이 들어올지 미리보기만.
 *
 * 예) tinyrich 63종을 전역 라이브러리로:
 *   node scripts/import-existing.mjs --from "D:/ClaudeCowork/webgame/games/tinyrich/tools/pixellab-cache" --scope global
 *
 * 무npm·무네트워크. 이미지가 없는 항목은 건너뛰고 리포트한다.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { resolveRoots, addEntry, entryView, entrySize, entryTool, entryFile } from './pixellab-cache.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = args.from && args.from !== 'true' ? args.from : null;
  if (!from) { console.error('사용법: node scripts/import-existing.mjs --from <디렉터리> [--scope global|project] [--dry-run]'); process.exit(1); }
  const scope = args.scope === 'project' ? 'project' : 'global';
  const dryRun = args['dry-run'] === 'true';
  const indexPath = path.join(from, 'index.json');
  const imagesDir = path.join(from, 'images');
  if (!existsSync(indexPath)) { console.error(`index.json 없음: ${indexPath}`); process.exit(1); }

  let src;
  try { src = JSON.parse(readFileSync(indexPath, 'utf8')); }
  catch (e) { console.error(`index.json 파싱 오류: ${e.message}`); process.exit(1); }
  const entries = Array.isArray(src.entries) ? src.entries : [];

  const roots = resolveRoots();
  const targetRoot = scope === 'project' ? roots.project : roots.global;
  console.log(`임포트: ${entries.length}개 후보 → [${scope}] ${targetRoot}${dryRun ? '  (dry-run)' : ''}`);
  console.log('─'.repeat(60));

  let imported = 0, skipped = 0, dups = 0;
  for (const e of entries) {
    const file = path.join(imagesDir, entryFile(e));
    if (!existsSync(file)) { console.log(`skip  ${e.id}  (이미지 없음: ${file})`); skipped++; continue; }
    if (dryRun) { console.log(`would ${e.id}  ${e.prompt || ''}`.slice(0, 90)); imported++; continue; }
    const res = addEntry(targetRoot, {
      scope,
      id: e.id,
      prompt: e.prompt || e.id,
      file,
      tags: e.tags || [],
      size: entrySize(e),
      view: entryView(e),
      tool: entryTool(e),
      palette: e.style && e.style.palette,
      outline: e.style && e.style.outline,
      assetType: e.assetType,
      pixellabObjectId: e.pixellabObjectId,
      frameIndex: e.frameIndex,
      sprites: e.sprites,
      license: e.license || {},
      createdAt: e.createdAt,
    });
    console.log(`ok    ${e.id}${res.duplicateOf ? '  (⚠️ 중복 of ' + res.duplicateOf + ')' : ''}`);
    imported++;
    if (res.duplicateOf) dups++;
  }
  console.log('─'.repeat(60));
  console.log(`${dryRun ? '미리보기' : '완료'}: 임포트 ${imported}, 건너뜀 ${skipped}, 정확중복 ${dups}`);
}

main();

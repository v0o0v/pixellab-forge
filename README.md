# pixellab-forge

**PixelLab MCP 위에 얹는 비용 절감 워크플로 + 재사용 캐시 레이어**인 Claude Code 플러그인이다. PixelLab MCP 서버 자체를 재구현하지 않는다 — 그 위에서 "새로 만들기 전에 이미 만든 걸 재사용"하게 만들어 generation 비용을 줄인다.

- **무npm·무네트워크**: Node 내장 모듈(`fs`/`path`/`url`/`crypto`/`os`)만 쓴다. 의존성 없음.
- **결정론적 유사도**: 임베딩 없이 어휘 기반 score. 셀프테스트 포함.
- **하이브리드 캐시**: 전역(공유 라이브러리) + 프로젝트 로컬(오버라이드).

## 무엇을 하나

1. PixelLab 로 이미지를 만들기 **전에** 재사용 캐시를 조회한다(`find`). 유사도 score ≥ **0.6** 이면 그 파일을 재사용(비용 0).
2. 정말 없을 때만(miss) PixelLab 로 생성하고, 생성분을 캐시에 **등록**(`add`)해 다음부터 재사용한다.
3. **스킬 지침** + **PreToolUse 훅**이 이 워크플로를 유도한다. 훅은 기본 **비차단(warn)** — 유사 캐시가 있으면 경고만 하고 생성을 막지 않는다.

## 설치

마켓플레이스로 설치(레포 배포 시):

```
/plugin marketplace add <이-레포>
```

```
/plugin install pixellab-forge@pixellab-forge
```

로컬 개발 로드:

```
claude --plugin-dir ./
```

(검증 명령이 있으면) 매니페스트 검증:

```
claude plugin validate ./
```

세션 안에서 다시 로드:

```
/reload-plugins
```

**전제**: 실제 이미지 생성에는 **PixelLab MCP 연결**이 필요하다. 이 플러그인은 그 위의 캐시/워크플로 레이어일 뿐이다(캐시 조회·등록은 MCP 없이도 동작).

## 하이브리드 캐시

두 계층이 있고, `find` 는 **project → global** 둘 다 조회한다(id 중복 시 project 우선).

| 계층 | 기본 경로 | 오버라이드 env | 성격 |
|---|---|---|---|
| global | `${CLAUDE_PLUGIN_DATA}/cache` (없으면 `~/.pixellab-forge/cache`) | `PIXELLAB_CACHE_GLOBAL` | 여러 프로젝트가 공유하는 기본 라이브러리 |
| project | `${CLAUDE_PROJECT_DIR}/.pixellab-cache` (없으면 `<cwd>/.pixellab-cache`) | `PIXELLAB_CACHE_PROJECT` | 현재 프로젝트 로컬 오버라이드 |

각 계층은 `index.json`(메타 대장) + `images/<id>.png`(원본)로 구성된다.

- **프로젝트 로컬 캐시(`.pixellab-cache/`)는 커밋 대상**(기본) — 팀이 같은 재사용 자산을 공유.
- **전역 캐시는 `${CLAUDE_PLUGIN_DATA}` 하위**라 커밋되지 않고 플러그인 업데이트에도 유지된다.

해석된 경로는 언제든 확인:

```
node scripts/pixellab-cache.mjs config
```

## CLI 명령 요약

`node scripts/pixellab-cache.mjs <명령>` (플러그인 안에서는 `${CLAUDE_PLUGIN_ROOT}/scripts/...`).

| 명령 | 설명 |
|---|---|
| `init` | 두 캐시 루트(`index.json` + `images/`) 생성 |
| `find "<설명>" [옵션]` | 유사 이미지 조회 → 재사용(≥0.6)/신규(<0.6) 판정 |
| `add --id --prompt --file [옵션]` | 캐시 등록(파일 복사 + 메타 append). `--scope` 기본 **global** |
| `list [--tags a,b] [--scope ...]` | 목록(scope 표기) |
| `get <id>` | 단일 항목 메타 + 이미지 절대경로 |
| `config` | 해석된 global/project 루트·임계값 출력 |
| `prune` | 파일 없는 항목 정리 + 용량 리포트 |
| `test` | 결정적 셀프테스트(PASS/FAIL) |

`find` 옵션: `--tags a,b` `--view sidescroller` `--size 42` `--tool create_1_direction_object` `--file <참조png>`(contentHash 정확 중복→1.0) `--style-strict`(호환 안 되는 항목 제외) `--top N`.

`add` 옵션: `--scope global|project` `--tags` `--size` `--view` `--tool` `--type(object|character|tile|tileset|ui|other)` `--object-id` `--frame` `--sprites s1,s2` `--palette` `--outline` `--license` `--author` `--source` `--date`.

### 메타 스키마(v2)

각 항목: `id, prompt, style{size,view,palette,outline,tool}, tags[], assetType, pixellabObjectId, frameIndex, files[], license{license,author,source}, contentHash(PNG sha256), createdAt, scope`.

- **contentHash**: `add` 시 PNG 바이트의 sha256 저장. `find --file` 로 준 이미지와 해시가 같으면 score=**1.0**(정확 중복).

## 유사도 / 임계값

- `score ∈ [0,1]` = `0.5×(prompt 대칭 Jaccard) + 0.5×(질의 포함도)`. 질의에 태그가 있으면 `0.7×prompt + 0.3×태그겹침`. view/size/tool 일치 소폭 보정.
- **REUSE_THRESHOLD = 0.6**. 최고 score 가 이 이상이면 "재사용 권장 + 파일 절대경로", 미만이면 "신규 생성 권장 + 생성 후 add 안내".
- 임베딩 없는 결정적 어휘 유사도(무npm). 정확 매칭이 아니라 **후보 추천**이다.

## 훅 동작(PreToolUse, 비차단)

`hooks/hooks.json` 이 `mcp__pixellab__(create|animate).*` 호출 직전에 `scripts/cache-guard.mjs` 를 실행한다.

- tool_input 의 `description/prompt/item_descriptions` 를 뽑아 `find` 로직으로 조회.
- 최고 score ≥ 0.6 매치가 있으면 **경고(stderr)** — 재사용 후보 경로 안내. **차단하지 않는다(exit 0)**.
- `PIXELLAB_GUARD_STRICT=1` 이면 강한 경고 문구(그래도 기본 비차단 — 차단은 오탐 위험이라 문서로만 안내).
- generation 사용 추정 로그를 `${CLAUDE_PLUGIN_DATA}/log/generations.log`(없으면 `os.tmpdir()` 폴백)에 append. 어떤 예외도 tool 실행을 막지 않는다.

## 기존 캐시 임포트

이미 만든 `pixellab-cache`(index.json + images/)를 전역 라이브러리로 가져오기:

```
node scripts/import-existing.mjs --from <기존캐시디렉터리> --scope global [--dry-run]
```

## 문서

- 스킬 지침: `skills/pixellab/SKILL.md`
- 사용 예시: `examples/README.md`
- 관련 문서: [plugins-reference](https://code.claude.com/docs/en/plugins-reference.md), [skills](https://code.claude.com/docs/en/skills.md), [plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces.md)

## 라이선스

MIT.

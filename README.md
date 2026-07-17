# pixellab-forge

**PixelLab MCP 위에 얹는 비용 절감 워크플로 + 재사용 캐시 레이어**인 Claude Code 플러그인이다. PixelLab MCP 서버 자체를 재구현하지 않는다 — 그 위에서 "새로 만들기 전에 이미 만든 걸 재사용"하게 만들어 generation 비용을 줄인다.

- **결정론적 유사도·무네트워크**: 임베딩·외부 API 없이 어휘 기반 score. 재사용 판정(`score`·0.6 임계값)은 100% 결정론적. 셀프테스트 포함.
- **검색 가속 인덱스(`better-sqlite3`)**: 애셋 수 N 에 무관한 검색 속도를 위해 SQLite FTS5 **온디스크 토큰 역색인**을 후보 추림에 쓴다. 이 파생 인덱스(`<root>/index.sqlite`)는 **gitignore·재빌드 가능**하며 `index.json`+PNG 원본이 진실의 원천. 판정은 여전히 기존 `score()` 가 소유(bm25 랭킹 미사용). → 최초 1회 `setup` 으로 설치.
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

### 검색 인덱스 의존 설치(최초 1회)

`find`/`add` 는 SQLite FTS5 파생 인덱스(`better-sqlite3`)를 사용한다. 최초 1회 설치가 필요하다:

```
node scripts/pixellab-cache.mjs setup
```

- `setup` 은 `better-sqlite3` 미설치 시에만 플러그인 루트에서 `npm install` 을 실행한다(win32-x64/darwin/linux prebuilt 바이너리, 컴파일 대개 불필요). 자동 설치는 **이 명령에서만** 일어난다 — `find`/`add`/훅은 절대 자동 설치하지 않는다.
- prebuild 부재 플랫폼이면 빌드 툴체인이 필요할 수 있다(실패 시 수동 안내 출력).
- **미설치 상태 동작**: CLI `find`/`add` 는 "setup 실행" 명확 에러 + 비정상 종료. **PreToolUse 훅은 1회 경고 후 `exit 0`(생성 비차단)** — 재사용 경고만 미출력되고 생성은 정상 진행된다.
- 파생 인덱스 `<root>/index.sqlite`(및 `-wal`/`-shm`)는 **gitignore·미커밋**. 부재/손상/`index.json` 변경 시 자동 rebuild. 수동 재구성은 `rebuild`(별칭 `reindex`).

## 하이브리드 캐시

두 계층이 있고, `find` 는 **project → global** 둘 다 조회한다(id 중복 시 project 우선).

| 계층 | 기본 경로 | 오버라이드 env | 성격 |
|---|---|---|---|
| global | `<플러그인 repo>/library` (git 커밋·push) | `PIXELLAB_CACHE_GLOBAL` | repo 에 함께 올라가는 공유 라이브러리(standalone·설치형·타 기기 pull 공유) |
| project | `${CLAUDE_PROJECT_DIR}/.pixellab-cache` (없으면 `<cwd>/.pixellab-cache`) | `PIXELLAB_CACHE_PROJECT` | 현재 프로젝트 로컬 오버라이드 |

각 계층은 `index.json`(메타 대장) + `images/<id>.png`(원본)로 구성된다.

- **프로젝트 로컬 캐시(`.pixellab-cache/`)는 커밋 대상**(기본) — 팀이 같은 재사용 자산을 공유.
- **전역 라이브러리는 플러그인 repo 안 `library/`** — git 으로 버전관리되어 생성 이미지가 repo 에 함께 push 된다(다른 기기·설치형은 repo 를 pull 해 공유). 에셋 라이선스는 `library/NOTICE.md`(PixelLab-ToS). 위치를 바꾸려면 `PIXELLAB_CACHE_GLOBAL` 로 오버라이드.

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
| `prune` | 파일 없는 항목 정리 + 용량 리포트(인덱스도 증분 삭제) |
| `setup` | `better-sqlite3`(검색 인덱스 백엔드) 설치 보장(최초 1회) |
| `rebuild` / `reindex` | `index.json` 전량으로 SQLite FTS5 인덱스 재구성 |
| `test` | 결정적 셀프테스트(PASS/FAIL) |

문서 재학습 게이트(`scripts/refresh-check.mjs`): 스킬 발동 시 마지막 학습일(`skills/pixellab/references/refresh-state.json`)에서 30일 경과 여부를 판정 — `check`(기본) | `mark [--date]` | `test`. STALE 이면 재학습 프로토콜(가이드 §10)을 세션 마무리에 수행한다. 생성 훅(cache-guard)도 STALE 시 경고를 낸다.

REST API 헬퍼(`scripts/pixellab-api.mjs`): MCP 에 없는 기능(인페인팅·이미지→픽셀아트·배경제거·회전 등)이나 대량 배치가 필요할 때 — `balance` | `call </경로> [--json ...] [--poll] [--save-images dir]` | `job <id>` | `test`(오프라인). 토큰은 `PIXELLAB_SECRET` env → `.mcp.json` 순으로 자동 해석(값 미출력). 판단 규칙은 `skills/pixellab/references/pixellab-mcp-guide.md` §9.

`find` 옵션: `--tags a,b` `--view sidescroller` `--size 42` `--tool create_1_direction_object` `--anchor <스타일앵커>` `--file <참조png>`(contentHash 정확 중복→1.0) `--style-strict`(호환 안 되는 항목 제외 — 앵커 불일치 포함) `--top N`.

`add` 옵션: `--scope global|project` `--tags` `--size` `--view` `--tool` `--anchor` `--type(object|character|tile|tileset|ui|other)` `--object-id` `--frame` `--sprites s1,s2` `--palette` `--outline` `--license` `--author` `--source` `--date`.

### 스타일 앵커 / 검수 도구

- **스타일 앵커**: 게임당 하나, `refs/<앵커이름>/` 의 참조 이미지 묶음을 매 생성 호출 `style_images` 로 투입해 스타일을 고정한다. `refs/` 는 **gitignore**(상용 게임 레퍼런스 원본 가능 — 재배포 금지, [ADR-0001](docs/adr/0001-style-anchor-refs-gitignore.md)). 캐시에는 `--anchor <이름>` 으로 이름만 기록.
- **컨택트시트**: `node scripts/contact-sheet.mjs <후보png들|디렉터리> --open` — review 팩 후보를 격자 HTML(base64 자기완결)로 만들어 브라우저 검수. 셀 번호는 0-based 로 `select_object_frames` 에 그대로 사용.

### 메타 스키마(v2)

각 항목: `id, prompt, style{size,view,palette,outline,tool,anchor}, tags[], assetType, pixellabObjectId, frameIndex, files[], license{license,author,source}, contentHash(PNG sha256), createdAt, scope`.

- **contentHash**: `add` 시 PNG 바이트의 sha256 저장. `find --file` 로 준 이미지와 해시가 같으면 score=**1.0**(정확 중복).

## 유사도 / 임계값

- `score ∈ [0,1]` = `0.5×(prompt 대칭 Jaccard) + 0.5×(질의 포함도)`. 질의에 태그가 있으면 `0.7×prompt + 0.3×태그겹침`. view/size/tool/anchor 일치 소폭 보정.
- **REUSE_THRESHOLD = 0.6**. 최고 score 가 이 이상이면 "재사용 권장 + 파일 절대경로", 미만이면 "신규 생성 권장 + 생성 후 add 안내".
- 임베딩 없는 결정적 어휘 유사도(무네트워크). 정확 매칭이 아니라 **후보 추천**이다. 검색은 SQLite FTS5 로 후보만 추리고, 판정 점수는 이 `score()` 가 그대로 계산한다(가속해도 판정 의미 불변).

## 훅 동작(PreToolUse, 비차단)

`hooks/hooks.json` 이 `mcp__pixellab__(create|animate).*` 호출 직전에 `scripts/cache-guard.mjs` 를 실행한다.

- tool_input 의 `description/prompt/item_descriptions` 를 뽑아 `find` 로직으로 조회.
- 최고 score ≥ 0.6 매치가 있으면 **경고(stderr)** — 재사용 후보 경로 안내. **차단하지 않는다(exit 0)**.
- `PIXELLAB_GUARD_STRICT=1` 이면 강한 경고 문구(그래도 기본 비차단 — 차단은 오탐 위험이라 문서로만 안내).
- **검색 인덱스 미설치/부재 시 degrade**: 훅은 인덱스를 rebuild 하지 않는다(`allowRebuild:false`). `better-sqlite3` 미설치면 1회 setup 힌트만 내고 재사용 경고를 건너뛴다. 인덱스가 stale/부재여도 조회를 skip 한다. **어떤 경우에도 생성을 막지 않고 `exit 0`**.
- generation 사용 추정 로그를 `${CLAUDE_PLUGIN_DATA}/log/generations.log`(없으면 `os.tmpdir()` 폴백)에 append. 어떤 예외도 tool 실행을 막지 않는다.

## 기존 캐시 임포트

이미 만든 `pixellab-cache`(index.json + images/)를 전역 라이브러리로 가져오기:

```
node scripts/import-existing.mjs --from <기존캐시디렉터리> --scope global [--dry-run]
```

## 문서

- 스킬 지침: `skills/pixellab/SKILL.md`
- PixelLab MCP + REST API 실전 가이드(공식 문서·OpenAPI 스펙 증류본, 2026-07-17 수집): `skills/pixellab/references/pixellab-mcp-guide.md`
- 사용 예시: `examples/README.md`
- 관련 문서: [plugins-reference](https://code.claude.com/docs/en/plugins-reference.md), [skills](https://code.claude.com/docs/en/skills.md), [plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces.md)

## 라이선스

MIT.

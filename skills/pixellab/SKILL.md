---
name: pixellab
description: PixelLab MCP 로 픽셀아트/스프라이트/아이콘을 생성할 때 따르는 비용 절감 워크플로. 픽셀아트·pixel art·스프라이트·sprite·아이콘·icon·타일·tile·게임 에셋 생성이 필요하거나 PixelLab 을 쓸 때 발동. 생성 전 재사용 캐시(전역+프로젝트 하이브리드)를 조회해 유사분을 재사용하고, miss 만 한 배치로 몰아서 생성해 generation 비용을 최소화한다.
---

# PixelLab Forge — 비용 절감 생성 워크플로

PixelLab MCP 로 픽셀아트 이미지를 만들 때는 **항상** 아래 순서를 따른다. 목표는 두 가지다: ① generation 비용 최소화(이미 있는 건 재사용, 꼭 필요한 것만 몰아서 생성), ② **사용자가 원하는 이미지를 정확히**(스타일 앵커 + 검수 루프). 용어는 `${CLAUDE_PLUGIN_ROOT}/CONTEXT.md` 를 따른다.

## 0) 자체 생성 금지 — 애매하면 질문

게임 화면에 들어가는 픽셀아트 성격 이미지(스프라이트·아이콘·타일·배경·키비주얼)는 **PixelLab 경유가 기본**이다. Claude 가 SVG·코드로 이미지를 직접 그리는 **자체 생성은 금지**. 예외는 순수 UI 도형(버튼 테두리·진행바 등 CSS/코드가 자연스러운 것)뿐이다. **어느 쪽인지 애매하면 조용히 자체 생성하지 말고 사용자에게 질문한다.** 임시 플레이스홀더가 필요해 보여도 마찬가지 — 먼저 묻는다.

핵심 도구는 재사용 캐시 CLI 하나다(무네트워크·결정론 판정):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-cache.mjs" <명령>
```

- **검색 인덱스 의존(최초 1회 setup)**: `find`/`add` 는 SQLite FTS5 파생 인덱스(`better-sqlite3`)로 후보를 추린다(판정 점수·0.6 임계값은 기존 `score()` 가 그대로 소유 — 의미 불변). 미설치면 CLI 는 "setup 실행" 에러를 낸다. 최초 1회 `node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-cache.mjs" setup` 으로 설치한다(자동 npm install 은 setup 에서만; find/add/훅은 자동설치 안 함). 파생 인덱스 `<root>/index.sqlite` 는 gitignore·재빌드 가능하며 `index.json`+PNG 원본이 진실의 원천. 부재/손상/`index.json` 변경 시 자동 rebuild, 수동 재구성은 `rebuild`.
- **PreToolUse 훅은 비차단**: 백엔드/인덱스 미설치여도 생성을 막지 않는다(재사용 경고만 미출력, `exit 0`).

- **도구 선택·파라미터·모드/비용이 불확실하면 먼저 `${CLAUDE_PLUGIN_ROOT}/skills/pixellab/references/pixellab-mcp-guide.md` 를 읽는다** — PixelLab 공식 AI 어시스턴트 가이드를 실제 도구 스키마와 대조해 증류한 것(도구 선택 지도·비차단 큐잉·애니메이션 품질 사다리·타일셋 체이닝·흔한 실수 10·REST API 판단 규칙). 이 문서와 실제 도구 스키마가 충돌하면 스키마가 이긴다.
- **MCP vs REST API**: 기본은 MCP. 단 ① MCP 에 없는 기능(인페인팅·이미지→픽셀아트·배경제거·회전·스켈레톤 애니메이션·의상 이전·스타일 전이 등) ② 대량 배치/파이프라인 ③ MCP 클라이언트 제약 회피(base64 잘림 등) — 이 세 경우는 REST API 를 쓴다(가이드 §9). 호출은 반드시 `${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-api.mjs` 헬퍼 경유(curl 직접 조립 금지 — 토큰 노출). **Pro 엔드포인트·대량 배치는 실행 전 예상 비용 고지 + 사용자 동의.**
- 플러그인 루트 참조는 `${CLAUDE_PLUGIN_ROOT}` 를 우선 쓴다. 훅/스킬 실행 맥락에서 이 변수가 안 잡히면 `${CLAUDE_SKILL_DIR}/../../scripts/pixellab-cache.mjs` 로 대체한다(이 SKILL.md 기준 스킬 디렉터리의 상위 2단계가 플러그인 루트다). 정확한 변수는 https://code.claude.com/docs/en/skills.md 참고.
- 캐시는 **하이브리드**다: 전역(global)이 공유 기본 라이브러리, 프로젝트 로컬(project)이 오버라이드. `find` 는 project→global 둘 다 조회한다. 해석된 경로는 `... config` 로 확인.

## 1) 전제 — PixelLab MCP 연결 확인

먼저 PixelLab MCP 가 연결돼 있는지 확인한다(`mcp__pixellab__*` 도구 가용 여부, 또는 `get_balance`/`list_projects` 로 확인). **미연결이면** 사용자에게 PixelLab MCP 연결을 안내하고 생성 단계는 중단한다(캐시 조회/등록은 연결 없이도 가능). 단, API 토큰이 잡히면(`node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-api.mjs" balance` 로 확인) **REST API 폴백을 사용자에게 제안**할 수 있다 — 임의로 진행하지 말고 물어본다. 우아한 실패: 연결이 없다고 임의로 대체 이미지를 만들지 않는다.

## 2) 스타일 앵커 확인 — 게임당 하나, 매 호출 투입

**스타일 앵커** = 한 게임의 모든 생성물이 공유하는 대표 참조 이미지 묶음. `${CLAUDE_PLUGIN_ROOT}/refs/<앵커이름>/` 에 있다(gitignore — 상용 게임 레퍼런스 원본일 수 있어 **어떤 리포에도 커밋·복사 금지**, ADR-0001·`refs/README.md` 참조).

- 생성 전에 이 게임의 앵커 폴더가 있는지 확인한다. **없으면 사용자에게 앵커 준비를 제안**한다(원하는 느낌의 게임 스크린샷/스프라이트 몇 장 → 대표 부분 크롭·256px 이하 축소). 사용자가 "앵커 없이"를 택하면 텍스트 스타일 지침만으로 진행.
- **매 생성 호출에 앵커를 `style_images` 로 투입**한다(base64). 프롬프트는 내용 설명에 집중하고 스타일은 앵커가 맡는다 — 이것이 "머릿속 그림과 다른 결과"와 "세트 스타일 불일치"를 막는 1차 장치다.
- ⚠️ `create_1_direction_object` 는 `style_images` 를 주면 `size` 를 무시하고 **가장 큰 참조 이미지 크기가 출력 크기**가 된다 → 목표 출력 크기로 리사이즈한 사본을 투입한다. 장수 제한: 출력 ≤85px → 8장, ≤170px → 4장, 그 외 1장.
- 캐릭터는 `create_character` v3 모드의 `reference_image_base64`(기존 스프라이트를 8방향 회전)도 고려.
- 산출물이 특정 상용 게임의 알아볼 수 있는 캐릭터/에셋 **근사 복제면 채택하지 않는다**.

## 3) 배치 설계 — 아키타입으로 축약, 애매하면 프로브

필요한 자산을 먼저 **목록화**한다. 그다음 **아키타입 축약**을 한다: 같은 개념·같은 스타일을 공유하는 항목을 하나의 생성 슬롯으로 묶는다(예: 같은 아이콘의 C/B/A/S 등급 변형은 한 계열로). 이렇게 하면 실제 생성해야 할 "슬롯" 수가 줄어든다. 스타일(size/view/팔레트/아웃라인/앵커)은 한 배치 안에서 **일관**되게 유지한다.

**프로브 배치**: 사용자가 원하는 걸 말로 좁히기 어려워하면(또는 방향이 여럿이면) 본 생성 전에 **최소 size 로 방향이 다른 후보를 싸게 한 팩** 뽑는다(≤42px 이면 한 팩 64프레임). 컨택트시트로 보여주고(6단계 참조) 사용자가 고른 방향만 본 생성으로 진행한다. 프로브 결과도 캐시에 `--tags probe` 로 등록한다(비용을 썼으니 재사용 대상).

## 4) 캐시 조회 — 생성 전 반드시 find

각 자산(또는 아키타입)마다 영문 설명으로 조회한다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-cache.mjs" find "<원하는 이미지 영문 설명>" [--tags a,b] [--view sidescroller] [--size 42] [--tool create_1_direction_object] [--anchor <앵커이름>] [--style-strict] [--top 5]
```

- **재사용 권장(최고 score ≥ 0.6)**: 출력된 **파일 절대경로**를 그대로 쓰거나 대상 위치로 복사한다. **PixelLab 호출 금지**(비용 0). `--file <참조png>` 를 주면 동일 바이트(contentHash)일 때 score=1.0 정확 중복으로 뜬다.
- **신규 생성 권장(score < 0.6)**: 그때만 생성 대상(miss)으로 표시한다.
- 스타일이 중요하면 `--view/--size/--tool/--anchor` 를 함께 줘 스코어를 보정하고, 호환 안 되는 항목을 배제하려면 `--style-strict`(앵커 불일치도 배제된다).
- **세트 일관성**: 앵커를 쓰는 게임이면 항상 `--anchor` 를 붙여 조회한다 — 다른 앵커로 만든 캐시가 재사용돼 세트가 깨지는 걸 막는다.

REUSE_THRESHOLD = **0.6**. 이는 후보 추천이지 정확 매칭이 아니므로, 채택 전 `get <id>` 로 원본 메타/경로를 확인한다.

## 5) miss 만 한 배치로 생성

캐시에 없던(miss) 자산만 PixelLab 로 만든다. **한 호출에 최대한 몰아서**(작은 size → 한 이미지에 다수 프레임) 생성한다. PixelLab `create_1_direction_object` 등의 프레임 규칙(대략):

| size(px) | 한 팩 프레임 수 | 대략 generation 비용 |
|---|---|---|
| ≤ 42 | 64 프레임 | 25 generations (실측 예: size=42, view=sidescroller, 64프레임 review 팩 1회) |
| ≤ 85 | 16 프레임 | 중간 |
| ≤ 170 | 4 프레임 | 소수 |

- 여러 아이콘이 필요하면 `item_descriptions` 배열에 몰아서 한 번에 뽑는다(개별 호출 반복 금지).
- size 는 용도에 맞는 **최소 크기**를 고른다. 작을수록 한 팩에 더 많은 프레임이 들어가 단가가 낮아진다.
- **비차단 큐잉**: 모든 `create_*`/`animate_*` 는 즉시 ID 를 반환한다 — 완성을 기다리지 말고 몰아서 큐잉한 뒤 `get_*` 로 나중에 폴링한다(캐릭터 생성 직후 애니메이션 큐잉 OK).
- **애니메이션은 싼 것부터**: template(방향당 1 gen) → v3(방향당 1 gen, 커스텀) → pro(방향당 20-40 gen). **pro 는 `confirm_cost` 2단계 필수** — 첫 호출로 비용을 확인해 사용자에게 보여주고, 명시 동의 후에만 true 로 재호출한다.
- **방향(view/direction)을 임의로 정하지 않는다** — 사용자가 명시하지 않았으면 물어본다(0단계 원칙).
- 도구별 상세(타일셋 체이닝, 맵 오브젝트 8시간 자동삭제, 키프레임 등)는 `references/pixellab-mcp-guide.md`.
- 스타일 일관성: 같은 배치는 동일한 앵커(`style_images`)/style prompt/팔레트/뷰를 유지한다(섞이면 재사용성이 떨어진다).

## 6) 검수 — 히어로 에셋은 사용자 눈으로

review 팩(size ≤170 은 후보 4/16/64장)이 오면 채택 판정을 **에셋 등급으로 분기**한다:

- **히어로 에셋**(캐릭터·보스·맵 배경·키비주얼·UI 기준 패널 — 반복 노출되거나 게임 정체성을 정의하는 것): **반드시 사용자 검수.** 후보를 내려받아 컨택트시트로 만들어 브라우저로 보여주고, 사용자가 고른 번호만 `select_object_frames` 로 확정한다:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/contact-sheet.mjs" <후보png들|디렉터리> --title "<아키타입>" --open
  ```

  (셀 번호는 0-based — `select_object_frames(indices=[...])` 에 그대로 쓴다.)
- **벌크 에셋**(대량 아이콘·소품): Claude 가 앵커/프롬프트 부합 기준으로 자동 선별하되, **선별 결과 컨택트시트를 사후 보고**해 사용자가 거부권을 행사할 수 있게 한다.
- 히어로인지 벌크인지 **애매하면 사용자에게 질문한다**(0단계 원칙과 동일).
- 채택할 후보가 없으면 `dismiss_review` 로 폐기하고, 프롬프트/앵커를 조정해 재생성한다 — 어긋난 결과를 그대로 게임에 넣지 않는다.

## 7) 적용 — 다운로드 후 매핑 복사

생성 결과(후보 URL/프레임)를 내려받아 대상 파일 위치에 매핑 복사한다. 한 팩의 여러 프레임을 각 자산 파일로 나눠 매핑한다(원본 아키타입 1장 → 여러 sprite 파일).

## 8) 등록 — 생성분을 캐시에 add

생성한 아키타입을 **반드시** 캐시에 등록한다. 다음부터 같은 설명이 오면 재사용된다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-cache.mjs" add \
  --id <새id> --prompt "<영문 설명>" --file <생성png경로> \
  --scope global \
  --tags a,b --size 42 --view sidescroller --tool create_1_direction_object \
  --anchor <앵커이름> \
  --type object --object-id <pixellab object id> --frame <n> --sprites s1,s2 \
  --license CC0 --author <author> --source <url>
```

- **`--anchor`**: 생성에 스타일 앵커를 썼으면 반드시 기록한다(앵커 **이름만** — 앵커 원본 이미지는 캐시에 넣지 않는다). 이후 `find --anchor` 세트 일관성 판정의 근거가 된다.

- `--scope` **기본 global**(전역 공유 라이브러리에 쌓는다). 이 프로젝트에서만 오버라이드할 땐 `--scope project`.
- **라이선스 메타(`--license --author --source`)** 를 가능하면 항상 채운다(재사용/재배포 안전).
- 전역 라이브러리는 플러그인 repo 안 `library/` 라 **git 으로 커밋·push**된다(생성 이미지가 repo 에 함께 올라감·타 기기 pull 공유). 프로젝트 로컬 캐시(`.pixellab-cache/`)는 소비 프로젝트에서 커밋 대상.

## 주의

- **MCP 미연결 시 우아한 실패**: 생성 불가를 알리고 중단. 캐시 조회/등록은 그대로 가능.
- **스타일 일관성**: 한 게임/한 세트는 같은 앵커·뷰·팔레트·아웃라인·해상도를 공유해야 시각적으로 어울리고 재사용성도 높다.
- **앵커 원본 유출 금지**: `refs/` 의 이미지는 상용 게임 레퍼런스일 수 있다 — `library/`·게임 리포·캐시 등 git 에 올라가는 어디로도 복사하지 않는다(ADR-0001).
- **비용 원칙 요약**: 재사용 우선 → miss 는 최소 size 로 한 배치에 몰아서 → 생성분은 즉시 add.
- **정확성 원칙 요약**: 애매하면 자체 생성 대신 질문 → 앵커로 스타일 고정 → 말로 안 좁혀지면 프로브 → 히어로 에셋은 사용자 검수.
- 참고: `${CLAUDE_PLUGIN_ROOT}/README.md`, `${CLAUDE_PLUGIN_ROOT}/examples/README.md`.

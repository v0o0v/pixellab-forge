---
name: pixellab
description: PixelLab MCP 로 픽셀아트/스프라이트/아이콘을 생성할 때 따르는 비용 절감 워크플로. 픽셀아트·pixel art·스프라이트·sprite·아이콘·icon·타일·tile·게임 에셋 생성이 필요하거나 PixelLab 을 쓸 때 발동. 생성 전 재사용 캐시(전역+프로젝트 하이브리드)를 조회해 유사분을 재사용하고, miss 만 한 배치로 몰아서 생성해 generation 비용을 최소화한다.
---

# PixelLab Forge — 비용 절감 생성 워크플로

PixelLab MCP 로 픽셀아트 이미지를 만들 때는 **항상** 아래 순서를 따른다. 목표는 generation 비용 최소화다: 이미 있는 건 재사용하고, 꼭 필요한 것만 한 번에 몰아서 만든다.

핵심 도구는 재사용 캐시 CLI 하나다(무npm·무네트워크, Node 내장 모듈만):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-cache.mjs" <명령>
```

- 플러그인 루트 참조는 `${CLAUDE_PLUGIN_ROOT}` 를 우선 쓴다. 훅/스킬 실행 맥락에서 이 변수가 안 잡히면 `${CLAUDE_SKILL_DIR}/../../scripts/pixellab-cache.mjs` 로 대체한다(이 SKILL.md 기준 스킬 디렉터리의 상위 2단계가 플러그인 루트다). 정확한 변수는 https://code.claude.com/docs/en/skills.md 참고.
- 캐시는 **하이브리드**다: 전역(global)이 공유 기본 라이브러리, 프로젝트 로컬(project)이 오버라이드. `find` 는 project→global 둘 다 조회한다. 해석된 경로는 `... config` 로 확인.

## 1) 전제 — PixelLab MCP 연결 확인

먼저 PixelLab MCP 가 연결돼 있는지 확인한다(`mcp__pixellab__*` 도구 가용 여부, 또는 `get_balance`/`list_projects` 로 확인). **미연결이면 이미지를 생성할 수 없으니**, 사용자에게 PixelLab MCP 연결을 안내하고 생성 단계는 중단한다(캐시 조회/등록은 연결 없이도 가능). 우아한 실패: 연결이 없다고 임의로 대체 이미지를 만들지 않는다.

## 2) 배치 설계 — 아키타입으로 축약

필요한 자산을 먼저 **목록화**한다. 그다음 **아키타입 축약**을 한다: 같은 개념·같은 스타일을 공유하는 항목을 하나의 생성 슬롯으로 묶는다(예: 같은 아이콘의 C/B/A/S 등급 변형은 한 계열로). 이렇게 하면 실제 생성해야 할 "슬롯" 수가 줄어든다. 스타일(size/view/팔레트/아웃라인/style prompt)은 한 배치 안에서 **일관**되게 유지한다.

## 3) 캐시 조회 — 생성 전 반드시 find

각 자산(또는 아키타입)마다 영문 설명으로 조회한다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-cache.mjs" find "<원하는 이미지 영문 설명>" [--tags a,b] [--view sidescroller] [--size 42] [--tool create_1_direction_object] [--style-strict] [--top 5]
```

- **재사용 권장(최고 score ≥ 0.6)**: 출력된 **파일 절대경로**를 그대로 쓰거나 대상 위치로 복사한다. **PixelLab 호출 금지**(비용 0). `--file <참조png>` 를 주면 동일 바이트(contentHash)일 때 score=1.0 정확 중복으로 뜬다.
- **신규 생성 권장(score < 0.6)**: 그때만 생성 대상(miss)으로 표시한다.
- 스타일이 중요하면 `--view/--size/--tool` 를 함께 줘 스코어를 보정하고, 호환 안 되는 항목을 배제하려면 `--style-strict`.

REUSE_THRESHOLD = **0.6**. 이는 후보 추천이지 정확 매칭이 아니므로, 채택 전 `get <id>` 로 원본 메타/경로를 확인한다.

## 4) miss 만 한 배치로 생성

캐시에 없던(miss) 자산만 PixelLab 로 만든다. **한 호출에 최대한 몰아서**(작은 size → 한 이미지에 다수 프레임) 생성한다. PixelLab `create_1_direction_object` 등의 프레임 규칙(대략):

| size(px) | 한 팩 프레임 수 | 대략 generation 비용 |
|---|---|---|
| ≤ 42 | 64 프레임 | 25 generations (실측 예: size=42, view=sidescroller, 64프레임 review 팩 1회) |
| ≤ 85 | 16 프레임 | 중간 |
| ≤ 170 | 4 프레임 | 소수 |

- 여러 아이콘이 필요하면 `item_descriptions` 배열에 몰아서 한 번에 뽑는다(개별 호출 반복 금지).
- size 는 용도에 맞는 **최소 크기**를 고른다. 작을수록 한 팩에 더 많은 프레임이 들어가 단가가 낮아진다.
- 스타일 일관성: 같은 배치는 동일한 style prompt/팔레트/뷰를 유지한다(섞이면 재사용성이 떨어진다).

## 5) 적용 — 다운로드 후 매핑 복사

생성 결과(후보 URL/프레임)를 내려받아 대상 파일 위치에 매핑 복사한다. 한 팩의 여러 프레임을 각 자산 파일로 나눠 매핑한다(원본 아키타입 1장 → 여러 sprite 파일).

## 6) 등록 — 생성분을 캐시에 add

생성한 아키타입을 **반드시** 캐시에 등록한다. 다음부터 같은 설명이 오면 재사용된다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-cache.mjs" add \
  --id <새id> --prompt "<영문 설명>" --file <생성png경로> \
  --scope global \
  --tags a,b --size 42 --view sidescroller --tool create_1_direction_object \
  --type object --object-id <pixellab object id> --frame <n> --sprites s1,s2 \
  --license CC0 --author <author> --source <url>
```

- `--scope` **기본 global**(전역 공유 라이브러리에 쌓는다). 이 프로젝트에서만 오버라이드할 땐 `--scope project`.
- **라이선스 메타(`--license --author --source`)** 를 가능하면 항상 채운다(재사용/재배포 안전).
- 프로젝트 로컬 캐시(`.pixellab-cache/`)는 **커밋 대상**(기본). 전역 캐시는 `~/.pixellab-forge/cache` 고정이라 커밋되지 않고 standalone·설치형이 공유한다.

## 주의

- **MCP 미연결 시 우아한 실패**: 생성 불가를 알리고 중단. 캐시 조회/등록은 그대로 가능.
- **스타일 일관성**: 한 게임/한 세트는 같은 뷰·팔레트·아웃라인·해상도를 공유해야 시각적으로 어울리고 재사용성도 높다.
- **비용 원칙 요약**: 재사용 우선 → miss 는 최소 size 로 한 배치에 몰아서 → 생성분은 즉시 add.
- 참고: `${CLAUDE_PLUGIN_ROOT}/README.md`, `${CLAUDE_PLUGIN_ROOT}/examples/README.md`.

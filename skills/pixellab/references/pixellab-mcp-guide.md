# PixelLab MCP + REST API 실전 가이드 (증류본)

> **출처**: https://api.pixellab.ai/mcp/docs (PixelLab 공식 AI 어시스턴트 가이드) + 실제 MCP 도구 스키마 대조 검증 + https://api.pixellab.ai/v2/openapi.json (REST API v2 스펙, 68경로).
> **수집일**: 2026-07-17. PixelLab 문서는 자주 갱신된다 — **이 문서와 실제 도구 스키마(description)/OpenAPI 스펙이 충돌하면 항상 스키마·스펙이 이긴다.**
> **범위**: 자동화 가능한 지식만(MCP 도구 + REST API). 수동 보정(브러쉬 인페인팅, init image 스케치, Aseprite 확장)은 웹 에디터(https://www.pixellab.ai) 영역 — 필요하면 사용자에게 웹 에디터를 안내한다.

## 1) 도구 선택 지도

| 만들 것 | 도구 | 비고 |
|---|---|---|
| 캐릭터(4/8방향 회전) | `create_character` | 사람/로봇=humanoid, 4족 동물=quadruped(template 필수: bear/cat/dog/horse/lion) |
| **기존 캐릭터 스프라이트 → 8방향** | `create_character` (mode=`v3`, `reference_image_base64`) | ❗`create_8_direction_object` 쓰지 말 것 — 캐릭터 identity 전달이 불안정 |
| 캐릭터 변형(옷·포즈·상태) | `create_character_state` | 회전 전체에 일관 적용, `use_color_palette_from_reference=true` 로 원본 팔레트 유지 |
| 캐릭터 애니메이션 | `animate_character` | 아래 "품질 사다리" 참조 |
| 아이콘·소품(1방향) | `create_1_direction_object` | size ≤170 이면 다중 후보 review 팩 |
| 소품 8방향 회전 | `create_8_direction_object` | max 168px. 소품 참조 회전 OK, 캐릭터는 ❌(위 참조) |
| 맵 위 오브젝트(배경 스타일 매칭) | `create_map_object` | 배경 이미지 주면 그 화풍에 맞춤(inpainting) |
| 탑다운 지형 타일셋 | `create_topdown_tileset` | Wang 16타일(transition_size=1.0 이면 25) |
| 플랫포머 타일셋 | `create_sidescroller_tileset` | `transition_description`(표면 레이어) 필수 |
| 아이소메트릭 타일 | `create_isometric_tile` | ~10-20초로 가장 빠름, 24px 초과 권장 |
| UI 패널·버튼 | `create_ui_asset` | 192-688px, `elements` 자동 배치, `seed` 재현 가능 |
| 초상화 / 폰트 | `create_portrait_character` / `create_font` | |

## 2) 공통 실행 모델 — 비차단 큐잉

모든 `create_*`/`animate_*` 는 **즉시 job/asset ID 를 반환**하고 백그라운드에서 처리된다(수십 초~5분).

- **몰아서 큐잉, 나중에 폴링**: 여러 생성을 연달아 큐잉해두고 `get_*` 로 상태를 나중에 확인한다. 캐릭터 완성을 기다렸다가 애니메이션을 큐잉하지 말 것 — `create_character` 직후 `animate_character` 를 바로 큐잉해도 된다.
- **review 상태**: `create_1_direction_object` 는 size ≤42→64후보, ≤85→16후보, ≤170→4후보의 review 팩을 만든다. `get_object` 로 후보 확인 → `select_object_frames(indices=[0-based])` 로 채택(각각 독립 오브젝트가 됨, `common_tag` 로 일괄 태깅 가능) 또는 `dismiss_review` 로 폐기.
- **다운로드는 즉시**: 결과 URL 은 인증 없이 받을 수 있다. 특히 `create_map_object` 결과는 **8시간 후 자동 삭제** — 완료 확인 즉시 내려받아 캐시에 `add` 한다.

## 3) 캐릭터 — 모드 비교

| mode | 비용 | 방향 | 특징 |
|---|---|---|---|
| `standard` | 1 generation | 4 또는 8 | 템플릿 스켈레톤 기반. 저렴. style 파라미터는 soft 가이드 |
| `v3` | 2-9 generations | 항상 8 | 최고 품질. **`reference_image_base64` 를 받는 유일한 모드**(south 향 스프라이트 → 8방향, 크기는 참조 이미지 따름, max 256px) |
| `pro` | 20-40 generations | 항상 8 | AI 참조 기반 고품질. style/proportions 파라미터 전부 무시 |

- `proportions` 프리셋: default, chibi, cartoon, stylized, realistic_male, realistic_female, heroic (humanoid 전용).
- `view`: low top-down(클래식 3/4 RPG) / high top-down / side / oblique(베타, 128px·4방향·standard 전용).
- canvas 는 캐릭터보다 ~40% 크게 잡힌다(애니메이션 여유 공간) — 48px 캐릭터 ≈ 68px 캔버스.

## 4) 애니메이션 — 품질 사다리 (싼 것부터)

1. **template** (방향당 1 gen): `template_animation_id` 지정. walk/run/idle 등 표준 동작. 전 방향 자동. 프레임 수는 템플릿 고정. 가용 템플릿은 `get_character` 로 확인(humanoid: walk, running-8-frames, jumping-1, fireball, taking-punch 등 50여 종).
2. **v3** (방향당 1 gen, 기본): `action_description` 으로 커스텀. `frame_count` 4-16 **짝수만**. **기본은 south 방향만** — 다른 방향은 `directions` 로 명시. 재롤이 싸다.
3. **pro** (방향당 20-40 gen): 완성된 방향을 참조로 순차 생성 — 고디테일 캐릭터용. **`confirm_cost` 2단계 필수**: 첫 호출은 confirm_cost 없이(비용 표시) → 사용자에게 비용 보여주고 명시 동의 → 그때만 true 로 재호출. 8방향이면 160-320 generations 다.

- 결과가 나쁘면: `delete_animation` 후 사다리 한 단계 위로.
- **커스텀 키프레임(v3 전용, 단일 방향)**: `custom_start_frame_*`(시작 포즈), `end_frame_*`(목표 포즈 — 보간 모드). **큰 이미지는 base64 대신 `*_url` 파라미터** — MCP 클라이언트가 base64 를 중간에 잘라 이미지가 깨질 수 있다.
- 일부 방향만 실패/누락됐으면 새 그룹을 만들지 말고 `animation_group_id` 로 기존 그룹에 방향을 추가한다.
- `action_description` 은 **움직임만** 기술("walking stealthily", "casting spell") — 장소·소품 등 환경 묘사 금지.

## 5) 타일셋/맵

- **탑다운(Wang)**: lower/upper 지형 설명 → 모서리 조합 16타일(transition_size=1.0 이면 25). `transition_size` 0=칼같은 경계, 1.0=타일 전체 절벽(높이차). transition_size>0 이면 `transition_description`("wet sand with foam") 권장.
- **타일셋 체이닝**: 바다→해변 타일셋 완성 후 `get_topdown_tileset` 으로 base tile ID 를 얻어 다음 타일셋(해변→잔디)의 `lower_base_tile_id` 로 연결 — 지형 전환이 시각적으로 이어진다. sidescroller 도 `base_tile_id` 로 동일.
- **사이드스크롤러**: 투명 배경·플랫폼 타일. `lower_description`(재질) + `transition_description`(표면: grass, snow…) 필수.
- **아이소메트릭**: `tile_shape` 로 두께(thin ~10% / thick ~25% / block ~50%). 24px 초과가 품질 유리. 처리 ~10-20초로 가장 빠르다.
- **맵 오브젝트 스타일 매칭**: `create_map_object` 에 `background_image`(base64) 를 주면 그 맵의 화풍으로 생성. inpainting 마스크 컨벤션: **흰색=생성 영역, 검은색=보존**. basic 모드 max 400px, inpainting 모드 max 192px. 파일 경로는 못 받는다 — base64 만.

## 6) 프롬프트 요령

- **구체적·시각적으로**: "wizard" ❌ → "wizard with blue robes and a crooked oak staff" ✅. 형태·색·재질을 명시.
- **내용과 스타일 분리**: 프롬프트는 내용 설명에 집중하고, 스타일은 `style_images`(스타일 앵커)가 맡는다. 같은 세트는 같은 앵커 재사용.
- 캐릭터 변형은 프롬프트 재작성 대신 `create_character_state`("sitting down", "wearing red armor") — identity 유지.
- `text_guidance_scale`(기본 8): 결과가 설명을 안 따르면 올리고, 너무 경직되면 내린다.
- `seed` 지원 도구(ui_asset, isometric, sidescroller, character_state)는 seed 고정으로 재현 가능.

## 7) 공식 비용/시간 감각

| 작업 | 비용(generations) | 시간 |
|---|---|---|
| create_character standard | 1 | ~2-5분 |
| create_character v3 | 2-9 | ~2-5분 |
| create_character pro | 20-40 | ~2-5분 |
| animate_character template/v3 | 방향당 1 | ~2-4분 |
| animate_character pro | 방향당 20-40 (8방향 160-320) | 길다 |
| create_1_direction_object | 20-40 (후보 팩 통째) | ~30-90초 |
| 타일셋 (topdown/sidescroller) | 변동 | ~100초 |
| create_isometric_tile | 소량 | ~10-20초 |
| create_ui_asset | 20-40 | ~30-90초 |

## 8) 흔한 실수 체크리스트 (공식 + 스키마 검증)

1. MCP 도구가 있는 작업에 curl/REST API 를 시도 ❌ — MCP 도구 직접 호출. **단 §9 판단 규칙의 예외 3조건이면 API 가 맞다.**
2. 기존 **캐릭터** 스프라이트 회전에 `create_8_direction_object` ❌ → `create_character(mode="v3", reference_image_base64=...)`.
3. template 애니메이션에 `directions` 강제 ❌ — 템플릿은 전 방향 자동.
4. 큰 이미지를 base64 로 인라인 전달 ❌ — `*_url` 파라미터 선호(base64 잘림 → 이미지 깨짐).
5. pro 전용/v3 전용 파라미터 혼용 ❌ — `keep_first_frame`·커스텀 키프레임은 v3 전용, pro 는 style 파라미터 무시.
6. **방향(view/direction)을 임의로 선택 ❌ — 사용자에게 명시적으로 확인**(플러그인 "애매하면 질문" 정책과 동일).
7. quadruped 에 `template` 생략 ❌ — 필수.
8. pro 모드를 비용 고지 없이 실행 ❌ — `confirm_cost` 2단계(위 4절).
9. `create_map_object` 결과 방치 ❌ — 8시간 자동 삭제, 즉시 다운로드+캐시 add.
10. `size` 와 `style_images`/`reference_image` 동시 지정 ❌ — 참조 이미지가 출력 크기를 결정한다.

## 9) REST API — MCP 보다 API 가 나은 때 (판단 규칙)

**기본은 MCP** (공식 권장: "MCP 도구를 사용할 수 있으면 직접 사용"). 단 아래 **예외 3조건**이면 REST API v2 를 쓴다:

1. **MCP 도구에 없는 기능** — API 전용 엔드포인트가 필요할 때 (아래 표).
2. **대량 배치 / 파이프라인 통합** — 수십 건 이상을 프로그램적으로 돌리거나 게임 빌드 스크립트에 통합할 때.
3. **MCP 클라이언트 제약 회피** — base64 인라인 잘림 등으로 MCP 경유가 깨질 때.

### API 전용 기능 (MCP 에 없음 — 예외 ① 대상)

| 기능 | 엔드포인트 | 핵심 파라미터(★=필수) |
|---|---|---|
| 임의 이미지 인페인팅 | `POST /inpaint`, `/inpaint-v3`(Pro) | description★, inpainting_image★, mask_image★(흰=생성/검=보존) |
| 일반 이미지 → 픽셀아트 | `POST /image-to-pixelart`, `-pro`(Pro) | image★, image_size★, output_size★ |
| 배경 제거 | `POST /remove-background` | image★, image_size★ |
| 리사이즈(픽셀아트 보존) | `POST /resize` | description★, reference_image★, target_size★ |
| 단일 회전(뷰/방향 변경) | `POST /rotate` | from_image★, from/to_view, from/to_direction |
| 스켈레톤 애니메이션 | `POST /animate-with-skeleton`, `/estimate-skeleton` | reference_image★, skeleton_keypoints |
| 애니메이션 보간 | `POST /interpolation-v2`(Pro) | start_image★, end_image★, action★ |
| 의상 이전 | `POST /transfer-outfit-v2`(Pro) | reference_image★, frames★ |
| 스타일 전이 생성 | `POST /generate-with-style-v2`(Pro), `/create-image-bitforge` | style_images★/style_image, description★ |
| 원시 이미지 생성 | `POST /create-image-pixflux`, `/generate-image-v2`(Pro) | description★, image_size★ |
| 이미지 편집(지시문) | `POST /edit-image`, `/edit-images-v2`(Pro) | image★, description★ |

전체 스펙: `https://api.pixellab.ai/v2/openapi.json` (대화형 문서 `/v2/docs`). MCP 와 동일 asset 계열(characters/objects/tilesets/ui)도 REST 로 있다 — 배치(예외 ②)에 사용.

### 호출 방법 — 반드시 헬퍼 경유

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-api.mjs" balance                # 무비용 스모크(토큰·잔액 확인)
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-api.mjs" call /remove-background --json-file req.json --save-images out/
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-api.mjs" call <경로> --json '<body>' --poll   # 비동기 job 자동 폴링
node "${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-api.mjs" job <job_id> --save-images out/
```

- **토큰**: `PIXELLAB_SECRET` env → `.mcp.json`(`mcpServers.pixellab.headers.Authorization`) 순으로 헬퍼가 알아서 읽는다. **curl 로 직접 조립 금지** — 토큰이 명령줄/로그에 남는다. 헬퍼는 토큰 값을 어떤 출력에도 찍지 않는다.
- **비용**: MCP 와 같은 계정 크레딧을 쓴다(USD 종량 — 예: 64px 이미지 ≈ $0.008, Pro 256px ≈ $0.095). **Pro 엔드포인트·대량 배치는 실행 전 예상 비용을 사용자에게 고지하고 동의받는다**(MCP `confirm_cost` 와 같은 정신 — API 에는 자동 게이트가 없으므로 스킬 규칙으로 지킨다). 시작 전 `balance` 로 잔액 확인.
- **산출물 처리**: API 로 만든 이미지도 동일하게 캐시에 `add` 한다(§비용 원칙). 스타일 앵커 규칙(§refs)도 동일 적용.

## 10) 재학습 프로토콜 — 30일마다 이 문서를 다시 증류한다

이 문서는 스냅샷이다. PixelLab 문서·스키마는 자주 갱신되므로 **마지막 수집일에서 30일이 지나면 재학습**한다. 신선도 판정은 `refresh-state.json` 기반:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/refresh-check.mjs"        # FRESH | STALE | UNKNOWN
```

**실행 시점**: 스킬 발동 시 게이트에서 STALE/UNKNOWN 이 뜨면 사용자에게 알리고, **원 작업(생성)을 먼저 끝낸 뒤 같은 세션 마무리에** 수행한다(사용자를 기다리게 하지 않는다).

**절차** (2026-07-17 최초 수집과 동일 방법):

1. **수집**: `refresh-state.json` 의 `sources` 를 fetch — ① `https://api.pixellab.ai/mcp/docs`(AI 어시스턴트 가이드) ② `https://api.pixellab.ai/v2/openapi.json`(엔드포인트/파라미터 — curl 로 내려받아 스크립트로 추출) ③ 필요 시 `pixellab.ai/docs` 신규 페이지.
2. **대조 검증**: 문서 주장을 **실제 MCP 도구 스키마**(ToolSearch 로 로드)와 대조한다. 충돌하면 스키마가 이긴다 — 이 원칙 덕에 낡은 웹 문서에 오염되지 않는다.
3. **갱신**: 이 문서(`pixellab-mcp-guide.md`)에서 달라진 부분만 고친다(도구/모드/비용/실수 목록/API 엔드포인트 표). 머리말의 수집일도 갱신. 범위 원칙 유지: MCP+API 자동화 지식만, 웹 에디터 UI 제외.
4. **기록**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/refresh-check.mjs" mark` (수집일 갱신).
5. **동기화**: 브랜치 `docs/pixellab-relearn-<YYYYMM>` → PR → **머지까지 자동 진행** — 사용자(v0o0v)가 2026-07-17 "문서 재학습 PR 한정 자동 진행" 상시 승인. 단 **스크립트/코드 변경이 섞이면 예외** — 그때는 머지 전 사용자 확인.
6. 변경 요지(달라진 것 몇 줄)를 사용자에게 보고한다. 변경이 전혀 없어도 mark + 동기화는 수행한다(다음 30일 카운트 리셋).

# PixelLab MCP 실전 가이드 (증류본)

> **출처**: https://api.pixellab.ai/mcp/docs (PixelLab 공식 AI 어시스턴트 가이드) + 실제 MCP 도구 스키마 대조 검증.
> **수집일**: 2026-07-17. PixelLab 문서는 자주 갱신된다 — **이 문서와 실제 도구 스키마(description)가 충돌하면 항상 스키마가 이긴다.**
> **범위**: MCP 로 자동화 가능한 지식만. 수동 보정(브러쉬 인페인팅, init image 스케치, Aseprite 확장)은 웹 에디터(https://www.pixellab.ai) 영역 — 필요하면 사용자에게 웹 에디터를 안내한다.

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

1. MCP 도구가 있는데 curl/REST API 를 시도 ❌ — MCP 도구 직접 호출.
2. 기존 **캐릭터** 스프라이트 회전에 `create_8_direction_object` ❌ → `create_character(mode="v3", reference_image_base64=...)`.
3. template 애니메이션에 `directions` 강제 ❌ — 템플릿은 전 방향 자동.
4. 큰 이미지를 base64 로 인라인 전달 ❌ — `*_url` 파라미터 선호(base64 잘림 → 이미지 깨짐).
5. pro 전용/v3 전용 파라미터 혼용 ❌ — `keep_first_frame`·커스텀 키프레임은 v3 전용, pro 는 style 파라미터 무시.
6. **방향(view/direction)을 임의로 선택 ❌ — 사용자에게 명시적으로 확인**(플러그인 "애매하면 질문" 정책과 동일).
7. quadruped 에 `template` 생략 ❌ — 필수.
8. pro 모드를 비용 고지 없이 실행 ❌ — `confirm_cost` 2단계(위 4절).
9. `create_map_object` 결과 방치 ❌ — 8시간 자동 삭제, 즉시 다운로드+캐시 add.
10. `size` 와 `style_images`/`reference_image` 동시 지정 ❌ — 참조 이미지가 출력 크기를 결정한다.

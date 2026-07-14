# pixellab-forge 사용 예시

아래 예시는 셸에서 직접 CLI 를 호출하는 흐름이다. 플러그인 안(스킬/훅)에서는 경로를 `${CLAUDE_PLUGIN_ROOT}/scripts/pixellab-cache.mjs` 로 쓴다. 무npm — `node` 만 있으면 된다.

## 0) 캐시 초기화 / 설정 확인

```
node scripts/pixellab-cache.mjs init
```

```
node scripts/pixellab-cache.mjs config
```

`config` 는 해석된 global/project 루트와 임계값(0.7)을 출력한다. 특정 위치로 바꾸려면 env 로 오버라이드:

```
PIXELLAB_CACHE_GLOBAL=/data/forge-global PIXELLAB_CACHE_PROJECT=./.pixellab-cache node scripts/pixellab-cache.mjs config
```

(Windows PowerShell 에서는 `$env:PIXELLAB_CACHE_GLOBAL="..."` 로 설정 후 실행.)

## 1) 생성 전 조회 — 재사용 여부 판정

```
node scripts/pixellab-cache.mjs find "a wooden desk with a monitor" --view sidescroller --size 42
```

- 최고 score ≥ 0.7 → **재사용 권장**: 출력된 절대경로 PNG 를 그대로 쓰거나 대상 위치로 복사(비용 0).
- < 0.7 → **신규 생성 권장**: 이때만 PixelLab 로 생성.

태그·스타일을 함께 주면 정밀해진다:

```
node scripts/pixellab-cache.mjs find "steel sword and shield" --tags equipment,weapon --style-strict
```

참조 이미지가 있으면 정확 중복(동일 바이트) 탐지:

```
node scripts/pixellab-cache.mjs find "any text" --file ./ref.png
```

## 2) miss 를 PixelLab 로 생성(개념)

`find` 가 신규 생성을 권한 자산만, PixelLab MCP 로 **한 배치에 몰아서** 생성한다(작은 size → 한 이미지에 다수 프레임). 예: `create_1_direction_object` 에 `item_descriptions` 배열로 여러 아이콘을 한 번에. size=42, 64프레임 review 팩 1회 ≈ 25 generations.

> 이 저장소는 캐시/워크플로 레이어라 실제 생성은 PixelLab MCP 가 한다. 여기서는 생성 결과 PNG 를 다음 단계에서 등록만 한다.

## 3) 생성분 등록 — 다음부터 재사용

```
node scripts/pixellab-cache.mjs add --id eq_workspace_C --prompt "a simple wooden office desk with a small computer monitor" --file ./out/desk.png --scope global --tags equipment,workspace,grade:C --size 42 --view sidescroller --tool create_1_direction_object --type object --object-id ef58722e-3685-4224-8e33-47039915756e --frame 0 --sprites item_workspace_01,item_workspace_02 --license CC0 --author pixellab --source https://pixellab.ai
```

- `--scope` 기본 **global**(전역 라이브러리). 이 프로젝트에서만 덮어쓸 땐 `--scope project`.
- 같은 바이트의 파일이 이미 있으면 `add` 가 정확 중복을 경고한다.

## 4) 목록 / 단일 조회 / 정리

```
node scripts/pixellab-cache.mjs list --tags equipment
```

```
node scripts/pixellab-cache.mjs get eq_workspace_C
```

```
node scripts/pixellab-cache.mjs prune
```

`prune` 은 이미지 파일이 사라진 항목을 대장에서 정리하고 용량을 리포트한다.

## 5) 셀프테스트

```
node scripts/pixellab-cache.mjs test
```

임시 디렉터리에 격리 실행 후 정리한다. 유사설명 재사용(≥0.7)·무관설명 신규(<0.7)·contentHash 정확중복·하이브리드 project 우선을 검증하고 PASS/FAIL 을 출력한다.

## 6) 기존 캐시 임포트(선택)

이미 만든 캐시를 전역 라이브러리로:

```
node scripts/import-existing.mjs --from ./old-cache --scope global --dry-run
```

`--dry-run` 으로 미리보기 후, 문제없으면 플래그 없이 실제 임포트한다.

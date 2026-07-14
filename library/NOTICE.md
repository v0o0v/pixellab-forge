# 라이브러리 에셋 라이선스 (NOTICE)

이 `library/` 디렉터리의 이미지들은 **PixelLab AI**(https://pixellab.ai)로 생성한 픽셀아트다.

## 라이선스: PixelLab-ToS
[PixelLab 이용약관](https://pixellab.ai/termsofservice) 기준:

- **소유권**: 생성물은 이 프로젝트(repo 소유자)가 소유한다(ToS §3.3).
- **사용**: 상업/비상업 사용·수정·배포 허용(별도 허가 불필요).
- **제한**: 이 이미지들을 **자체 ML 모델 학습에 사용 금지**(ToS §1.2, 서면 허가 없이). **Open RAIL-M** 참조(§4.1).
- **주의**: 순수 AI 생성물은 일부 관할에서 저작권 등록이 제한될 수 있다. 제3자 권리 비침해 책임은 이용자에게 있다.

> 그래서 이 에셋은 **CC0(무제한 공용)가 아니다**. 위 use-based 제한 때문에 `license: PixelLab-ToS` 로 표기한다.

## 재사용
각 이미지의 메타(prompt·style·object id·license)는 `index.json` 에 있다.
조회: `node scripts/pixellab-cache.mjs find "<설명>"` → score≥0.6 이면 해당 PNG 재사용.

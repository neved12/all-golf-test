# data/sources — 원본 자료 보관 위치

이 폴더는 원본 PDF를 커밋하지 않습니다. `.gitignore`의 `data/sources/*.pdf` 규칙으로 로컬 파일만 둡니다.

## 한국골프장경영협회 2025 가이드북 회원사 현황

- 원문: <https://www.kgba.co.kr/guidebook/2025/guidebook2025_04.pdf>
- 기준일: 2024-12-08
- 전국 목록(`data/national-golf-courses.js`)을 다시 만들 때만 원문을 `data/sources/kgba-2025-member-courses.pdf`로 내려받아 사용합니다.

```bash
curl -L -o data/sources/kgba-2025-member-courses.pdf https://www.kgba.co.kr/guidebook/2025/guidebook2025_04.pdf
node scripts/import-kgba-courses.js
```

저작권은 협회에 있으며, 이 저장소는 원문을 재배포하지 않고 출처 URL과 가공한 골프장 명부만 공개합니다.

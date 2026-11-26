# data/sources — 원본 자료 보관 위치

이 폴더에는 **원본 자료(PDF·CSV·ZIP)** 와 **정제된 중간 레이어(JSON)** 가 함께 있습니다.
저작권·용량 때문에 원본은 커밋하지 않고(`.gitignore`: `*.pdf`, `*.csv`, `*.zip`),
정제 레이어와 생성 스크립트만 저장소에 올립니다.

`data/national-golf-courses.js` 는 아래 원본을 `scripts/build-national-courses.js` 로 병합해 만듭니다.
원본을 새로 내려받은 뒤에는 항상 같은 스크립트를 다시 실행하세요.

```bash
node scripts/build-national-courses.js
node tests/national-data-integrity.js
```

## 1. 문화체육관광부 「전국 골프장 현황」 (기준일 2024-12-31)

- 데이터: <https://www.data.go.kr/data/15118920/fileData.do> (파일데이터, CSV, 이용허락범위 제한 없음)
- 내려받은 파일: `data/sources/mcst-national-golf-courses-20241231.zip`
- 골프장 541행(시설 494곳, 운영형태·코스별로 2행인 곳 있음). 이름·사업자·소재지·면적·홀수·구분(회원제/대중제/비회원제) 제공.
- 실제 코스 골프장만 담긴 공식 등록 현황이므로 **골프장 여부 판별의 기준 명부**로 사용합니다.

```bash
# 공공데이터포털 파일데이터는 로그인 없이 내려받을 수 있습니다(브라우저 내려받기 → 위 경로로 이동).
```

## 2. 행정안전부 「생활_골프장」(골프장업 인허가)

- 데이터: <https://www.data.go.kr/data/15045080/fileData.do> (파일데이터, CSV, 이용허락범위 제한 없음)
- 실제 파일: <https://file.localdata.go.kr/file/download/golf_courses/info>
- 내려받은 파일: `data/sources/localdata-golf-courses-20261126.csv` (CP949, 655행)
- 영업상태(영업/정상·폐업·휴업·취소/말소), 사업장명, 도로명·지번주소, 전화번호, 인허가일자를 제공.
- **영업 중 여부·연락처·현행 주소**를 확인하는 데 사용합니다. 실내 골프장·골프연습장 라이선스도 섞여 있어 그대로 쓰면 안 됩니다.

```bash
curl -L -A "Mozilla/5.0" -e "https://file.localdata.go.kr/file/golf_courses/info" \
  -o data/sources/localdata-golf-courses-20261126.csv \
  "https://file.localdata.go.kr/file/download/golf_courses/info"
```

## 3. 한국골프장경영협회 2025 가이드북 회원사 현황 (기준일 2024-12-08)

- 원문: <https://www.kgba.co.kr/guidebook/2025/guidebook2025_04.pdf>
- 구조화 결과: `data/sources/kgba-2025-records.json` (커밋 대상, 203곳)
- 회원제·대중제 홀수와 대표 전화를 제공합니다. 협회 회원사 명부이므로 군 체력단련장처럼 회원사가 아닌 골프장은 빠져 있습니다.

```bash
curl -L -o data/sources/kgba-2025-member-courses.pdf https://www.kgba.co.kr/guidebook/2025/guidebook2025_04.pdf
NODE_PATH=<pdfjs-dist가 설치된 node_modules> node scripts/import-kgba-courses.js
```

## 4. 기타 커밋 대상 레이어

| 파일 | 내용 |
|---|---|
| `kgba-2025-records.json` | 협회 명부 구조화 결과(위 3번) |
| `legacy-demo-courses.json` | 기존 시연 예약 68곳의 id·이름·지역(시연 ID 보존용) |
| `localdata-course-map.json` | 인허가 데이터 수동 정리 규칙(명칭 변경 병합·부속시설 제외·신규 등록, 사유 포함) |

원문 저작권은 각 기관에 있으며, 이 저장소는 원문을 재배포하지 않고 출처 URL과 가공한 골프장 명부만 공개합니다.

# ALL:GOLF 골프장 마스터 데이터

전국 골프장 마스터는 공식 공개 데이터 3종을 병합해 만듭니다. 정확한 출처·기준일·건수·제외 기준은
[`national-verification-report.md`](national-verification-report.md)에, 재현 방법은
[`sources/README.md`](sources/README.md)에 정리되어 있습니다.

## 파일 구성

| 파일 | 역할 | 커밋 |
|---|---|---|
| `national-golf-courses.js` | 전국 골프장 정보 레코드(자동 생성). `window.ALL_GOLF_NATIONAL_COURSES` / `ALL_GOLF_NATIONAL_METADATA` | O |
| `golf-courses.js` | 병합 계층. 시연 예약 68곳(고정 ID·`bookingStatus: "demo"`)을 전국 마스터에 붙이고 `window.ALL_GOLF_COURSES`/`ALL_GOLF_REGIONS`를 만든다 | O |
| `demo-teetimes.js` | 시연 예약 가격·티타임. 실제 판매 데이터가 아니다 | O |
| `national-build-report.json` | 생성 통계·수동 병합 근거·제외 목록(자동 생성) | O |
| `sources/` | 원본 자료(비커밋)와 정제 레이어·정리 규칙(커밋) | 일부 |
| `partner-application.js` · `partner-sync.js` | 제휴 신청·승인 저장소 | O |
| `server-catalog.js` · `server-reservations.js` | 서버 연동 모드의 티타임·재고 캐시 | O |

## 원칙

- **공식 출처만**: 문화체육관광부 「전국 골프장 현황」, 행정안전부 「생활_골프장」(골프장업 인허가),
  한국골프장경영협회 회원사 명부. 확인되지 않은 값은 `null`로 둔다.
- **영업 중 코스 골프장만**: 폐업·휴업·직권말소와 실내 골프장·골프연습장·당구장·간이(파3) 시설은 제외한다.
- **정보 전용은 `bookingStatus: "info"`**: 새로 추가된 골프장에는 실제 요금·티타임을 만들지 않는다.
  `greenFee`·`cartFee`·`caddieFee`·`officialBookingUrl`은 `null`, `bookable`은 `false`다.
- **시연 예약 골프장 보존**: 기존 68곳의 `id`와 `bookingStatus: "demo"`는 데이터를 다시 생성해도 바뀌지 않는다
  (`sources/legacy-demo-courses.json`이 고정 목록이며, 생성 결과에 같은 ID로 포함된다).
- **중복 금지**: 이름·주소·인허가 라이선스를 대조해 같은 골프장을 한 번만 등록한다. 명칭이 바뀐 골프장은
  `sources/localdata-course-map.json`에 병합 근거를 남긴다.

## 갱신 절차

```bash
# 1) 원본 내려받기 (sources/README.md 참고)
# 2) 전국 마스터 재생성
node scripts/build-national-courses.js
# 3) 데이터 무결성 + 전체 회귀 테스트
npm test
```

`national-golf-courses.js`와 `national-build-report.json`은 자동 생성 파일이므로 직접 수정하지 않습니다.

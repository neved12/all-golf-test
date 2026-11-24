# ALL:GOLF 7단계 완료 보고서 — 골프장별 계정·권한 및 티타임·특가 서버 연동

- 저장소: `neved12/all-golf-test` (`main`)
- 기준 커밋: `2a91ab8` (6단계 완료)
- 작업 브랜치: `feat/stage7-partner-accounts-teetimes`
- PR: **#13** → 머지 커밋 **`b176dcbe278798f39c916ee445a8c7161061b3ee`**
- 배포: GitHub Pages **built** (`https://neved12.github.io/all-golf-test/`, HTTP 200)
- 성격: **시연용**. 실제 결제·실제 골프장 예약·외부 골프장 API·정산은 포함하지 않습니다.
- 예약 재고의 서버 이전은 **8단계** 범위이며, 이번 단계에서는 화면에 그 한계를 명시했습니다.

---

## 1. 요약

| 요구 | 결과 |
|---|---|
| 골프장별 담당자 계정(생성·활성/비활성·소속 courseId) | 완료 · 본사 관리자 화면/API, `PN-YYMMDD-NNNN` |
| 서버 로그인/로그아웃, scrypt 해시+salt, HttpOnly 쿠키/HMAC 만료 | 완료 · `crypto.scryptSync`, HMAC 토큰(`p1.*`), `allgolf_partner` 쿠키 |
| 본사(`admin`)·골프장(`partner`) 권한 구분, 변경 시 세션 즉시 무효화 | 완료 · `sessionEpoch` 대조로 비활성화·권한 변경·비밀번호 재설정 시 즉시 401 |
| 6단계 본사 HMAC 인증과 공존 | 완료 · `v1.*`(본사)/`p1.*`(골프장) 분리, 교차 사용 401 |
| 비밀번호·토큰 공개 저장소 비노출 | 완료 · `.env.example`만 커밋, DB/`.env`/백업 Git 제외, 응답에 해시 없음 |
| 골프장별 데이터 격리(서버 권한 검증, 403) | 완료 · 모든 담당자 API가 세션 courseId 기준, 타 골프장 CRUD 403 |
| 본사 관리자 전체 조회·계정 활성/비활성 | 완료 · `/api/admin/operations`, `/api/admin/partner-accounts` |
| 티타임 서버 CRUD·중복 방지·검증·409·삭제 차단 | 완료 · 코스/날짜/시간/부/팀/인원/그린피/상태, version 충돌 409 |
| 요금·특가 서버 CRUD(3인·4인·할인율) | 완료 · 기본/3인/4인 그린피, 추가금, 카트·캐디·예약금, 특가 기간·팀·노출 |
| 고객 앱 API 우선 조회 + SSE/폴링 | 완료 · `/api/public/catalog`, `catalog.changed` SSE + 15초 폴링 |
| 정적 모드 네트워크 0건 폴백·배지 | 완료 · GitHub Pages 실브라우저에서 `/api/` 요청 0건 확인 |
| 예약 재고 공유 과장 금지 | 완료 · `inventoryLinked:false`, 화면에 “예약 확장은 시연(로컬)·8단계” 명시 |
| 파트너/본사 화면 연동 | 완료 · 서버 로그인, 티타임/요금/특가 CRUD, 계정 관리, 운영 현황, 감사 로그 |
| 안정성(원자적 저장·백업·재시작 유지) | 완료 · 파일 DB v2, 기존 잠금/백업 유지, DB v1 자동 보완 |
| 기존 회귀 120 + 6단계 90 유지 | **120/120 · 90/90 통과** |
| 7단계 신규 테스트 | **187/187 통과** |
| 화면 스크립트 스모크 | **22/22 통과** |
| PR·main 병합·Pages 배포 | 완료 · PR #13, `b176dcb`, Pages `built`, HTTP 200 |

---

## 2. 구현 방식과 설계 판단

### 2.1 외부 패키지 0개 유지

6단계와 동일하게 Node.js 내장 모듈만 사용했습니다. 집 Windows PC에서 `npm install` 없이 `npm start`/`start-server.bat`으로 실행됩니다.
비밀번호 해시는 `crypto.scryptSync`(N=16384, r=8, p=1, 64바이트, 계정별 16바이트 salt), 세션은 `crypto.createHmac('sha256')`을 씁니다.

### 2.2 세션을 두 종류로 분리한 이유

- 본사 관리자 토큰: 기존 `v1.<payload>.<sig>` 그대로 유지(6단계 호환).
- 골프장 담당자 토큰: 접두사 `p1`, payload에 `accountId·courseId·sessionEpoch·role` 포함.
- 서명 키는 같은 `SESSION_SECRET`을 쓰지만 토큰 종류별 서명 문자열(`v1.` / `partner.v1.`)을 달리해 위조·교차 사용을 막습니다.
- 검증은 매 요청마다 DB의 계정 상태와 `sessionEpoch`를 다시 대조합니다. 그래서 **비활성화·권한 변경·비밀번호 재설정이 즉시 반영**되고, 서버를 재시작해도 유지됩니다.

### 2.3 데이터 격리를 라우터 한 곳에서 강제한 이유

`courseId`를 요청 본문에서 받아 쓰면 브라우저에서 변조할 수 있습니다. 그래서 담당자 API는 **세션에서 courseId를 꺼내고**, 요청에 다른 courseId가 있으면 `403`을 반환합니다.
레코드 ID로 접근하는 수정·삭제도 먼저 레코드를 찾은 뒤 소유 골프장을 비교해 `403`을 돌려줍니다(없는 ID는 404).

### 2.4 수정 충돌은 `version` 기반 낙관적 잠금

티타임·요금·특가·계정 모두 `version`을 가집니다. 수정 요청에 `version`이 없으면 400, 현재 값과 다르면 `409`와 함께 최신 레코드를 응답에 담아 화면이 바로 안내할 수 있게 했습니다.
파일 DB의 프로세스 큐 + 파일 잠금 안에서 검사·갱신하므로 동시에 두 요청이 와도 하나만 성공합니다.

### 2.5 고객 앱은 “보여 주는 정보”만 서버에서 받는다

예약·재고 잠금은 아직 브라우저 `localStorage`입니다. 서버 티타임을 화면에 그대로 보여 주면서 로컬 예약이 서버 재고를 차감하는 것처럼 보이면 안 되므로:

- 서버 티타임은 별도 카탈로그 캐시(`allGolfServerCatalogV1`)에 두고, 화면에서 **“골프장 등록”**으로 구분합니다.
- 이 브라우저의 시연 예약 수만큼만 잔여 팀을 줄여 보여 줍니다.
- 상세 화면에 “예약 확정·재고 차감은 이 브라우저의 시연 예약으로만 처리되며 서버 재고와 연동되지 않습니다(8단계)”를 표시합니다.
- 공개 API 응답에도 `inventoryLinked:false`와 안내 문구를 포함합니다.

---

## 3. DB 구조 (스키마 버전 2)

`server/data/db.json` (Git 제외) / 시드 `server/data/db.seed.json` (Git 포함)

```json
{
  "version": 2,
  "meta": { "createdAt": "", "updatedAt": "", "revision": 0, "sequences": {}, "lastBackupDate": "" },
  "applications": [],
  "approvedCourses": [],
  "partnerAccounts": [
    {
      "id": "PN-261124-0001",
      "courseId": "ap-...",
      "email": "partner@example.com",
      "name": "담당자명",
      "role": "owner | manager | viewer",
      "status": "active | disabled",
      "passwordHash": "scrypt 결과(hex)",
      "passwordSalt": "16바이트(hex)",
      "passwordAlgo": "scrypt",
      "passwordParams": { "N": 16384, "r": 8, "p": 1, "keylen": 64 },
      "sessionEpoch": 1,
      "version": 1,
      "createdAt": "", "updatedAt": "", "createdBy": { "type": "admin", "email": "" },
      "lastLoginAt": null, "passwordUpdatedAt": ""
    }
  ],
  "teeTimes": [
    {
      "id": "tt-...",
      "courseId": "ap-...",
      "courseName": "골프장명",
      "course": "전체(또는 코스명)",
      "date": "2026-11-25",
      "time": "07:30",
      "session": "1부",
      "capacityTeams": 2,
      "maxPlayers": 4,
      "greenFee": 160000,
      "status": "open | stopped | closed",
      "note": "",
      "bookedTeams": 0,
      "heldTeams": 0,
      "version": 1,
      "createdAt": "", "updatedAt": "",
      "createdBy": { "type": "partner", "email": "", "accountId": "" },
      "updatedBy": { "type": "partner", "email": "", "accountId": "" }
    }
  ],
  "rates": {
    "ap-...": {
      "baseGreenFee": 160000,
      "weekdayGreenFee": null,
      "weekendGreenFee": null,
      "threePlayerGreenFee": 180000,
      "threePlayerSurcharge": 10000,
      "fourPlayerGreenFee": 150000,
      "twoPlayerSurcharge": 5000,
      "cartFee": 110000,
      "caddieFee": 150000,
      "depositType": "none | team | person | percent",
      "depositValue": 30000,
      "version": 1,
      "updatedAt": "", "updatedBy": {}
    }
  },
  "specialOffers": [
    {
      "id": "so-...",
      "courseId": "ap-...",
      "teeTimeId": "tt-...",
      "roundDate": "2026-11-25",
      "time": "07:30",
      "name": "특가명",
      "description": "",
      "regularPrice": 160000,
      "specialPrice": 128000,
      "discountAmount": 32000,
      "discountRate": 20,
      "saleStartAt": "ISO", "saleEndAt": "ISO",
      "teamLimit": 2,
      "visible": true,
      "paused": false,
      "deletedAt": null,
      "version": 1,
      "createdAt": "", "updatedAt": "", "createdBy": {}, "updatedBy": {}
    }
  ],
  "reservations": [],
  "bookingHolds": [],
  "auditLogs": []
}
```

- 기존 6단계 `db.json`(버전 1)은 읽을 때 빈 7단계 컬렉션을 보완해 **자동으로 그대로 사용**합니다.
- `reservations`·`bookingHolds`는 8단계용 자리이며 7단계 API는 만들지 않습니다. (테스트에서 삭제 차단 조건을 검증할 때만 임시 DB 파일에 직접 넣습니다.)
- 접수번호 `PA-YYMMDD-NNNN`, 계정 `PN-YYMMDD-NNNN`은 한국 시간 기준 일자별 순번을 `meta.sequences`에 보관해 재시작해도 이어집니다.

### 백업·복구·초기화

```bash
npm run db:backup       # backups/db-YYYY-MM-DD-HHMMSS-manual.json
npm run db:restore -- server/data/backups/db-2026-11-24.json
npm run db:reset-demo   # "RESET" 입력, 초기화 전 백업 자동 생성
```

- 저장은 임시 파일 → fsync → rename(원자적 교체), 쓰기는 프로세스 큐 + `db.json.lock`.
- JSON 손상 시 조용히 초기화하지 않고 `db.json.corrupt-<시각>.json` 사본과 최신 백업 경로를 안내하며 중단합니다.
- 백업/복구 스크립트가 담당자 계정·티타임·특가 건수도 출력합니다.

---

## 4. 권한 구조

### 4.1 역할

| 역할 | 코드 | 권한 |
|---|---|---|
| 본사 관리자 | `admin` (환경변수 1계정, 6단계) | 전체 골프장 조회, 제휴 승인·반려, 담당자 계정 생성·활성/비활성·비밀번호 재설정, 전체 운영 현황·감사 로그 |
| 골프장 대표 관리자 | `owner` | 자기 골프장 티타임·요금·특가 CRUD (계정 관리 불가) |
| 골프장 운영 담당 | `manager` | 자기 골프장 티타임·요금·특가 CRUD |
| 골프장 조회 전용 | `viewer` | 자기 골프장 조회만, 쓰기 API는 `403 forbidden_role` |

### 4.2 세션·권한 규칙

| 상황 | 서버 동작 |
|---|---|
| 로그인 성공 | HMAC 토큰 + `allgolf_partner` HttpOnly·SameSite=Lax 쿠키(HTTPS면 Secure), 12시간 |
| 로그아웃 | 토큰 `jti` 폐기 + 쿠키 삭제 |
| 계정 비활성화 | `sessionEpoch` 증가 → 기존 토큰 즉시 `401 account_disabled` |
| 역할·소속 골프장 변경 | `sessionEpoch` 증가 → 기존 토큰 `401 session_invalidated` |
| 비밀번호 재설정 | `sessionEpoch` 증가 + 새 해시 저장 → 기존 세션 전부 만료 |
| 사용 재개 | `sessionEpoch`가 다시 증가하므로 이전 토큰은 계속 무효, 새 로그인만 허용 |
| 다른 골프장 courseId로 요청 | `403 forbidden_course` |
| 제휴 승인 안 된 골프장 계정 | 생성 `400`, 접근 시 `403 course_not_approved` |
| 본사 토큰으로 담당자 API / 담당자 토큰으로 본사 API | `401` |

### 4.3 계정 발급 방법

1. 본사 관리자 화면 → **제휴 계정 관리** → `+ 계정 생성` (골프장 선택, 이메일·이름·권한, 초기 비밀번호 비우면 자동 생성)
2. 초기 비밀번호는 **생성 직후 한 번만** 화면에 표시됩니다. 서버·DB에는 해시만 남습니다.
3. 시연 편의: `npm run demo:partner-accounts` (승인 골프장마다 계정 생성, 콘솔에 1회 출력)
   또는 `ALLGOLF_SEED_DEMO_PARTNER_ACCOUNTS=1`로 서버 시작 시 자동 생성(시연 전용).

---

## 5. API 목록

공통: JSON, 실패 시 `{ "ok": false, "error": { "code", "message", "details?" } }`.
인증: 본사 `Authorization: Bearer <v1…>` 또는 `allgolf_admin` 쿠키 / 담당자 `Authorization: Bearer <p1…>` 또는 `allgolf_partner` 쿠키.

### 5.1 공개

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/health` | 상태·버전(`stage:7`)·기능 플래그·건수 |
| GET | `/api/partner-courses` | 승인 제휴 골프장 공개 목록 |
| GET | `/api/partner-courses/:id` | 승인 골프장 1곳 |
| GET | `/api/partner-courses/:id/tee-times?date=` | **서버 등록 티타임 우선**, 없으면 기존 시연 5건(`source: demo`) |
| GET | `/api/public/catalog?date=&courseId=` | 고객 앱용 티타임·요금·특가 카탈로그, `managedCourseIds`, `inventoryLinked:false` |
| POST | `/api/partner-applications` | 제휴 신청 접수(6단계) |
| GET | `/api/partner-applications/:id?code=|phone=` | 본인 신청 조회(6단계) |
| GET | `/api/events` | SSE: `partner-courses.changed`, `catalog.changed`, `tee-times.changed`, `application.decided` |

### 5.2 본사 관리자

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/admin/login` / `/api/admin/logout` / GET `/api/admin/session` | 본사 세션(6단계) |
| GET | `/api/admin/partner-applications` · `/api/admin/partner-applications/:id` | 신청 목록·상세 |
| POST | `/api/admin/partner-applications/:id/approve` · `/reject` | 승인·반려 |
| GET | `/api/admin/audit-logs?applicationId=&action=&courseId=&limit=` | 감사 로그(계정·티타임·요금·특가 포함) |
| GET | `/api/admin/stats` | 건수 요약(7단계 확장) |
| GET | `/api/admin/partner-accounts?courseId=&status=&q=` | 담당자 계정 목록·통계 |
| POST | `/api/admin/partner-accounts` | 계정 생성(초기 비밀번호 1회 응답) |
| GET | `/api/admin/partner-accounts/:id` | 계정 상세 |
| PATCH | `/api/admin/partner-accounts/:id` | 상태·권한·이름·소속 변경(version, 변경 시 세션 무효화) |
| POST | `/api/admin/partner-accounts/:id/reset-password` | 비밀번호 재설정(새 비밀번호 1회 응답) |
| GET | `/api/admin/operations?date=` | 골프장별 티타임·특가·계정·최근 변경 요약 |
| GET | `/api/admin/tee-times?courseId=&date=` | 본사 전체 티타임 조회 |
| GET | `/api/admin/special-offers?courseId=&date=` | 본사 전체 특가 조회 |

### 5.3 골프장 담당자

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/partner/login` | 이메일·비밀번호 로그인 → `p1` 토큰 + HttpOnly 쿠키 |
| POST | `/api/partner/logout` | 로그아웃 |
| GET | `/api/partner/session` | 세션·계정·골프장 확인 |
| GET | `/api/partner/dashboard` | 골프장·계정·요금·건수·예약 안내(로컬 시연 표시) |
| GET | `/api/partner/tee-times?date=&from=&to=` | 자기 골프장 티타임 |
| POST | `/api/partner/tee-times` | 티타임 등록 |
| PATCH | `/api/partner/tee-times/:id` | 수정(`version` 필수, 충돌 409) |
| DELETE | `/api/partner/tee-times/:id?version=` | 삭제(예약·임시확보·특가 연결 시 409) |
| POST | `/api/partner/tee-times/recurring` | 날짜 반복 등록(최대 90일, 중복 건너뜀) |
| GET | `/api/partner/rates` · PUT `/api/partner/rates` | 요금 조회·저장 |
| GET | `/api/partner/special-offers?date=&status=` | 특가 목록 |
| POST | `/api/partner/special-offers` | 특가 등록 |
| PATCH | `/api/partner/special-offers/:id` | 특가 수정(충돌 409, 기간 겹침 409) |
| DELETE | `/api/partner/special-offers/:id` | 특가 삭제(기록 보존 soft delete) |

### 5.4 상태 코드

| 코드 | 상황 |
|---|---|
| 400 | 입력 검증 실패(필드별 `details.errors`), `version` 누락, 중복 이메일·약한 비밀번호 |
| 401 | 토큰 없음·위조·만료, 로그아웃됨, 계정 비활성/권한 변경으로 세션 무효 |
| 403 | 다른 골프장 데이터, 조회 전용 계정의 쓰기, 제휴 승인 안 된 골프장, 중지된 계정 로그인 |
| 404 | 없는 신청·계정·티타임·특가 |
| 409 | 중복 티타임, 수정 충돌, 특가 기간 겹침, 예약/특가 연결 티타임 삭제 |
| 429 | 로그인·조회 시도 과다 |

---

## 6. 가격 계산 규칙

- `baseGreenFee`는 **4인 기준 1인 그린피**입니다.
- 날짜별 기본가: 평일 `weekdayGreenFee`, 주말 `weekendGreenFee`가 있으면 그 값, 없으면 `baseGreenFee`.
- 인원별 1인 그린피:
  - 4인: `fourPlayerGreenFee`가 있으면 그 값, 없으면 기준가
  - 3인: `threePlayerGreenFee`가 있으면 그 값, 없으면 기준가 + `threePlayerSurcharge`
  - 2인: 기준가 + `twoPlayerSurcharge`
- 특가가 진행 중이고 노출 중이면 그린피를 `specialPrice`로 바꾸고, 정상가는 `regularPrice`로 표시합니다.
- 할인 금액 = 정상가 − 특가, 할인율 = 반올림(할인 금액 × 100 / 정상가). 서버가 계산해 저장합니다.
- 고객 앱 계산과 같은 결과가 나오도록 서버가 `rates`를 앱 형식(`price + 2·3인 추가금`)으로 변환해 내려줍니다.

---

## 7. 화면 연동

### 7.1 `/partner/`

- 서버 모드: 담당자 이메일·비밀번호 로그인 → 담당 골프장만 표시(골프장 전환 UI 없음), 권한·마지막 갱신 표시
- 운영 현황: 등록 티타임, 선택일 티타임, 판매 중 특가, 활성 계정, 예약 현황(이 브라우저 시연 예약임을 명시)
- 티타임 관리: 날짜별 목록, 추가·수정·판매 중지/재개·삭제, 날짜 반복 등록
- 요금 설정: 기본/3인/4인·추가금·카트·캐디·예약금 방식
- 특가 관리: 목록·등록·수정·중지/재개·삭제, 정상가·특가·할인율 표시
- 로그아웃 시 토큰·쿠키 삭제, 로그인 화면 복귀
- 정적 모드: 기존 6단계 시연 화면 그대로(서버 요청 0건)

### 7.2 `/admin/`

- 신규 메뉴 **제휴 계정 관리**: 계정 목록(골프장·권한·상태·마지막 로그인), 생성, 사용 중지/재개, 비밀번호 재설정
- 신규 메뉴 **골프장 운영 현황**: 날짜별 골프장 티타임·특가·계정 건수, 마지막 수정, 최근 변경, 상세 티타임 모달
- **승인 처리 이력**에 담당자 로그인·계정 변경·티타임·요금·특가 변경이 함께 표시(`auditLabel`)
- 정적 모드에서는 두 메뉴 모두 “서버 실행 시 사용 가능” 안내를 표시(오류 없음)

### 7.3 고객 앱 `/`

- 서버 연동 시 현재 날짜의 공개 카탈로그를 API로 조회하고, SSE/15초 폴링으로 변경을 반영
- 서버에 등록된 티타임이 있으면 그 티타임을 우선 표시하고 “골프장 등록” 안내를 붙임
- 정적 호스팅에서는 요청을 보내지 않고 기존 시연 티타임으로 폴백, 좌하단 배지로 구분

---

## 8. 테스트 결과

실행:

```bash
npm test                            # 회귀 + 6단계 + 7단계
node tests/run-ui-smoke.js          # 화면 스크립트 스모크(partner/admin)
```

| 구분 | 결과 |
|---|---|
| 기존 회귀(1~5단계) `tests/run-scenarios.js` | **120/120 통과, 0 실패** |
| 6단계 서버·DB `tests/run-server-scenarios.js` | **90/90 통과, 0 실패** |
| 7단계 계정·권한·운영 `tests/run-stage7-scenarios.js` | **187/187 통과, 0 실패** |
| 화면 스크립트 스모크 `tests/run-ui-smoke.js` | **22/22 통과, 0 실패** |
| 합계 | **419개 검사 통과** |

### 8.1 7단계 테스트가 실제로 확인한 것

- 서버 상태(`stage:7`)·기능 플래그·DB 초기값, 정적 앱에 서버 카탈로그 스크립트 포함
- A/B 두 골프장 제휴 승인 후 계정 발급(수동·자동 비밀번호), 중복 이메일·약한 비밀번호·미승인 골프장 차단
- 계정 응답·로그·목록에 `passwordHash`/`passwordSalt`/`sessionEpoch` 비노출
- 담당자 로그인·세션, 잘못된 비밀번호 401, 본사/담당자 토큰 교차 사용 401
- A 티타임 등록 201, 버전 1, 잔여=예약 가능 팀, 상태 라벨
- 잘못된 날짜·과거 날짜·잘못된 시간·팀 0·인원 5·시간/부 불일치·음수 가격 400
- 같은 날짜·시간·코스 중복 409, 조회 전용 계정 쓰기 403
- A의 B 티타임 조회·수정·삭제·B 명의 등록 403, B의 A 요금 수정 403
- `version` 누락 400, 오래된 version 409(최신 레코드 포함), 정상 version 200·버전 증가
- 요금 저장(3인 180,000원·4인 150,000원), 음수·120% 예약금 400, 오래된 version 409
- 특가 등록(할인 32,000원·20%), 정상가 이상 400, 팀 초과 400, 기간 겹침 409, B의 수정 403
- 특가 숨김 시 고객 카탈로그 미적용, 다시 노출 시 적용
- 공개 카탈로그: `2인 165,000 / 3인 180,000 / 4인 150,000`, `inventoryLinked:false`, 계정 정보 없음
- 기존 공개 티타임 API가 서버 티타임 우선(`source: server`), 없는 날짜는 시연 5건(`source: demo`)
- 특가 연결 티타임 삭제 409(`offer_linked`)
- 본사 운영 현황 합계·골프장별 건수·최근 변경, 본사 전체 티타임/특가 조회
- 감사 로그에 `partner.login`, `partner-account.created`, `tee-time.created/updated`, `rates.updated`, `special-offer.created/updated`와 담당자 이메일
- 계정 비활성화 → 기존 토큰 401·쓰기 401·로그인 403, 재개 후에도 이전 토큰 401, 새 로그인 성공
- 비밀번호 재설정 → 기존 토큰 401, 이전 비밀번호 401, 새 비밀번호 로그인 성공
- 서버 재시작 후 계정·티타임(버전 2)·요금·특가 유지, DB에 평문 비밀번호 없음
- DB에 예약 1건을 넣고 재시작한 뒤 해당 티타임 삭제 409(`tee_time_in_use`), 미사용 티타임 삭제 200
- 날짜 반복 등록(월·수·금), 같은 조건 재등록 시 전부 건너뜀
- 정적 모드 API 클라이언트·서버 카탈로그 모두 네트워크 요청 0건
- 실제 고객 앱 코드(dom-shim)에서 서버 티타임 1건 표시, 특가 128,000원/정상가 160,000원/20%, 3인 추가금 30,000원, 4인 추가금 0원, 시연 예약 1건 후 잔여 2팀, 서버 카탈로그가 없으면 기존 시연 티타임

### 8.2 화면 스모크가 확인한 것 (실제 서버 연결)

- partner: 로그인 화면 → 서버 로그인 → 운영 현황 렌더(담당자·골프장명) → 티타임 관리 → 추가 모달 → 저장(서버 저장·목록 표시) → 요금 화면 → 3인 그린피 저장(서버 반영) → 로그아웃
- admin: 서버 로그인 → 대시보드 → 제휴 계정 관리(기존 계정 표시) → 계정 생성 모달 → 초기 비밀번호 1회 표시 → 목록 반영 → 골프장 운영 현황(티타임 1건) → 감사 로그(담당자 로그인·티타임 등록)

### 8.3 검증하지 못한 범위 (솔직한 한계)

- **`127.0.0.1` 실브라우저 UI E2E는 실행하지 못했습니다.** 이 환경의 원격 브라우저가 loopback 주소를 차단합니다(`private/loopback address 127.0.0.1 is not allowed`). 대신 API 통합 테스트 + 실제 서버에 화면 스크립트를 붙인 DOM 스모크로 검증했습니다.
- 서버 모드 화면은 실제 브라우저의 CSS·레이아웃·모바일 뷰포트까지 확인하지 못했습니다. 정적 모드 화면만 실제 브라우저(GitHub Pages)에서 확인했습니다.
- 부하·동시 다중 프로세스·대용량 데이터 성능은 측정하지 않았습니다(파일 DB 단일 프로세스 전제).
- 실제 결제·실골프장 예약·문자/푸시 알림·정산은 구현하지 않았습니다(범위 외).
- 브라우저 자동화로 콘솔을 직접 수집할 수는 없어, 페이지 로드 후 오류 리스너를 설치하고 목록·상세·날짜 전환·관리자 메뉴 이동을 수행해 **오류 0건**을 확인했습니다. 로드 시점의 콘솔 오류는 `performance` 리소스 상태(모두 200)와 화면 렌더 정상으로 간접 확인했습니다.

---

## 9. 배포 결과

- PR #13 → `main` 머지 커밋 `b176dcbe278798f39c916ee445a8c7161061b3ee`
- GitHub Pages 빌드: `status: built`, 해당 커밋 기준(`2026-11-24T10:01:36Z`)
- HTTP 확인

| URL | 상태 |
|---|---|
| `https://neved12.github.io/all-golf-test/` | 200 |
| `https://neved12.github.io/all-golf-test/partner/` | 200 |
| `https://neved12.github.io/all-golf-test/admin/` | 200 |
| `data/server-catalog.js?v=20261124-stage7` | 200 |
| `app.js`, `partner/partner.js`, `admin/admin.js` (stage7) | 200 |

- 정적 자산 캐시 버전을 세 화면 모두 `?v=20261124-stage7`로 갱신했습니다.
- 실브라우저 확인: 사용자 앱 목록·상세·날짜 전환 정상, 좌하단 `○ 정적 시연` 배지, `/api/` 요청 0건, 오류 0건.
  본사 관리자의 신규 메뉴(제휴 계정 관리·골프장 운영 현황)도 정적 모드 안내와 함께 정상 렌더됩니다.

증빙 스크린샷:

- `downloads/allgolf-stage7-evidence/01-pages-home-static-mode.png`
- `downloads/allgolf-stage7-evidence/02-pages-partner-static-mode.png`
- `downloads/allgolf-stage7-evidence/03-pages-admin-accounts-static.png`
- `downloads/allgolf-stage7-evidence/04-pages-admin-operations-static.png`
- `downloads/allgolf-stage7-evidence/test-results.txt` (419개 검사 전체 출력)
- `downloads/allgolf-stage7-evidence/pages-verification.txt` (Pages 빌드·HTTP 상태)

---

## 10. 집 Windows PC에서 실행하는 방법

```powershell
cd <저장소 폴더>
git pull
npm start
```

또는 탐색기에서 `start-server.bat` 더블클릭. **`npm install`은 필요 없습니다**(외부 패키지 0개, C++ 빌드 없음).
Node.js 18 이상이 필요합니다.

| 화면 | 주소 |
|---|---|
| 사용자 앱 | <http://127.0.0.1:4173/> |
| 골프장 관리자 | <http://127.0.0.1:4173/partner/> |
| 본사 관리자 | <http://127.0.0.1:4173/admin/> |
| API 상태 | <http://127.0.0.1:4173/api/health> |

### 10.1 처음 한 번: 제휴 골프장과 담당자 계정 만들기

1. `http://127.0.0.1:4173/partner/` → **골프장 제휴 신청**에서 골프장을 신청합니다(기존 골프장 선택 또는 신규 입력).
2. `http://127.0.0.1:4173/admin/` → 기본 비밀번호 `allgolf-demo-2026`(또는 `.env`의 `ADMIN_PASSWORD`)로 로그인 → **제휴 신청 관리**에서 승인합니다.
3. **제휴 계정 관리** → `+ 계정 생성`에서 승인된 골프장을 고르고 이메일·이름·초기 비밀번호를 입력합니다.
   - 비밀번호를 비우면 자동 생성되며, 생성 직후 화면에 한 번만 표시됩니다.
4. `/partner/`로 돌아가 그 이메일·비밀번호로 로그인합니다.

빠르게 시연하려면:

```bash
npm run demo:partner-accounts
# 승인된 골프장마다 partner.<id>@allgolf.demo / allgolf-partner-2026 계정 생성 (콘솔에 1회 출력)
```

또는 `.env`에 `ALLGOLF_SEED_DEMO_PARTNER_ACCOUNTS=1`을 넣고 서버를 시작하면 승인 골프장에 자동 생성됩니다(시연 전용).

### 10.2 환경변수

`.env.example`을 `.env`로 복사해 채웁니다.

| 변수 | 설명 |
|---|---|
| `ADMIN_PASSWORD` | 본사 관리자 비밀번호(미설정 시 시연용 `allgolf-demo-2026`) |
| `SESSION_SECRET` | 세션 서명 키(32자 이상 권장, 비우면 재시작마다 세션 만료) |
| `SESSION_TTL_HOURS` / `PARTNER_SESSION_TTL_HOURS` | 본사 8시간 / 담당자 12시간 기본 |
| `ALLGOLF_SEED_DEMO_PARTNER_ACCOUNTS` | `1`이면 시작 시 시연 담당자 계정 자동 생성 |
| `DEMO_PARTNER_PASSWORD` | 자동 생성/스크립트용 시연 비밀번호 |
| `ALLGOLF_DB_PATH`, `ALLGOLF_BACKUP_DIR` | DB·백업 경로 |
| `PORT`, `HOST` | 포트·바인딩(휴대폰 접속은 `HOST=0.0.0.0`) |
| `ALLGOLF_ALLOWED_ORIGINS` | GitHub Pages 등 다른 출처에서 붙일 때 허용 |

### 10.3 6단계에서 쓰던 DB가 있는 경우

`git pull` 후 그대로 `npm start`하면 됩니다. 서버가 기존 `db.json`(버전 1)을 읽어 7단계 컬렉션을 빈 값으로 보완합니다.
승인 골프장은 그대로 유지되며, 담당자 계정만 새로 만들면 됩니다.

---

## 11. 파일 DB의 한계와 8단계 준비 사항

### 11.1 한계

- 단일 서버 프로세스 전제입니다. 파일 잠금으로 같은 PC의 다중 프로세스는 막지만, 여러 대의 서버가 같은 파일을 공유하는 구성은 지원하지 않습니다.
- 데이터가 커질수록 매 변경마다 JSON 전체를 다시 쓰므로 대량 트래픽에 부적합합니다. 감사 로그는 10,000건에서 오래된 항목을 정리합니다.
- 로그아웃 폐기 목록은 메모리에 있습니다. `SESSION_SECRET`이 고정되어 있으면 서버 재시작 후 만료 전 토큰이 다시 유효해질 수 있습니다(계정 비활성화·권한 변경은 `sessionEpoch`로 DB에 남아 재시작 후에도 유효).
- 쿠키 인증은 `SameSite=Lax`로 CSRF를 완화했지만 별도 CSRF 토큰은 없습니다(시연 범위).
- 시연용 기본 비밀번호·자동 계정 생성은 편의 기능입니다. 실제 운영에서는 반드시 끄고 강한 비밀번호를 쓰세요.

### 11.2 8단계(예약 서버 이전) 준비

이번 단계에서 미리 만들어 둔 것:

- `teeTimes.bookedTeams` / `heldTeams` 필드와 `remaining` 계산, 삭제 차단 시 `reservations`·`bookingHolds` 검사
- `reservations`·`bookingHolds` 컬렉션과 감사 로그 구조
- 담당자 세션·골프장 격리, 공개 카탈로그(`inventoryLinked:false`)
- 서버 잠금·버전 충돌 패턴

8단계에서 해야 할 일:

1. 예약 생성·취소·환불을 서버 API로 이전하고, 티타임 잔여 차감을 **파일 잠금 안 트랜잭션**으로 처리(중복 예약 방지·멱등 키).
2. 임시확보(hold) TTL·만료 정리, 예약번호 서버 발급.
3. 고객 앱의 `localStorage` 예약을 서버 예약으로 대체하고, 기존 로컬 예약은 “시연 기록”으로 분리 표시.
4. 담당자 화면의 예약 현황을 서버 데이터로 전환, 취소·노쇼·환불 정책 서버 계산.
5. 재고가 실제로 공유되므로 `inventoryLinked:true`로 바꾸고 화면 문구 갱신.
6. 트래픽이 생기면 PostgreSQL/MySQL + 마이그레이션으로 이전(파일 DB는 시연·소규모 전제).

---

## 12. 보안·개인정보 처리

- 비밀번호: 계정별 salt + `scrypt` 해시만 저장. 응답·로그·감사 메모에 평문/해시를 남기지 않습니다.
- 세션: HttpOnly·SameSite=Lax 쿠키(HTTPS면 Secure), HMAC 서명·만료·폐기 검증, 매 요청 계정 상태 대조.
- 비밀값: `.env`·`db.json`·백업·잠금 파일은 `.gitignore`로 제외. `.env.example`에는 값이 아닌 안내만 둡니다.
- 공개 API 최소화: 공개 카탈로그·제휴 목록에 담당자 이메일·전화·메모·계정 정보가 없습니다(테스트로 확인).
- 정적 서빙 차단: `/server/`, `.env`, `.git` 등은 404, 퍼센트 인코딩 우회도 차단(6단계 유지).
- 개인정보(담당자 연락처·이메일)가 들어가므로 공개 인터넷에 무기한 노출하지 말고, 시연 종료 시 `npm run db:reset-demo`로 정리하세요.

---

## 13. 변경 파일

```
server/lib/accounts.js            계정 검증·scrypt 해시·ID·시연 계정 시드
server/lib/partner-auth.js        담당자 HMAC 세션·로그아웃·시도 제한
server/lib/operations.js          티타임·요금·특가 검증·가격 계산·공개 카탈로그
server/lib/db.js                  스키마 v2·신규 컬렉션·상태 건수
server/lib/config.js              담당자 세션 TTL·시연 계정 설정
server/routes/api.js              담당자 인증/CRUD, 본사 계정·운영, 공개 카탈로그
server/index.js                   PartnerAuth 연결·시연 계정 시드·7단계 로그
server/scripts/seed-partner-accounts.js   시연 담당자 계정 일괄 생성
server/scripts/{backup,restore,reset-demo}.js  건수·안내 갱신
server/data/db.seed.json          스키마 v2 시드
server/data/README.md             스키마·백업·초기화 안내
data/api-client.js                담당자 토큰 저장/삭제
data/server-catalog.js            공개 카탈로그 동기화·SSE/폴링·캐시
data/shared-store.js              applyServerOperations(요금·특가 병합)
app.js                            서버 티타임 우선 표시·시연 예약 수 반영·안내 문구
partner/partner.js, partner.css, partner/index.html   서버 로그인·티타임/요금/특가 CRUD
admin/admin.js, admin.css, admin/index.html           계정 관리·운영 현황·감사 라벨
index.html                        server-catalog 로드·캐시 버전 stage7
README.md, .env.example, package.json, start-server.*   실행·설정·스크립트·버전 7.0.0
tests/run-stage7-scenarios.js     7단계 187개
tests/run-ui-smoke.js             화면 스크립트 스모크 22개
tests/README.md                   테스트 안내
```

---

## 14. 결론

7단계 요구 사항(골프장별 계정·권한, 서버 측 데이터 격리, 티타임·요금·특가 CRUD, 고객 앱 API/SSE 반영, 파트너·본사 화면, 안정성)을 구현하고
기존 120 + 90건과 신규 187 + 22건, 총 **419개 검사**를 통과했습니다. PR #13으로 `main`에 병합했고 GitHub Pages 빌드·HTTP 200·
정적 모드 실브라우저 동작(요청 0건·오류 0건)을 확인했습니다.

가장 중요한 남은 한계는 **예약 재고가 아직 서버로 이전되지 않았다는 점**이며, 화면과 API 모두에 이를 명시했습니다. 이 이전과 실제 결제·정산·외부 연동이 8단계 이후 과제입니다.

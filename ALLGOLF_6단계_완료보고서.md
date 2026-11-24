# ALL:GOLF 6단계 완료 보고서 — 서버·DB 기반 다중 사용자 공통 데이터 시스템

- 저장소: `neved12/all-golf-test` (`main`)
- 작업 브랜치: `feat/stage6-server-db` → PR **#9** → 머지 커밋 `b69a01d`
- 기준 커밋: `34b1f82` (5단계 완료)
- 성격: **시연용**. 실제 결제·실제 골프장 예약·외부 골프장 API 연동은 포함하지 않습니다.

---

## 1. 요약

| 요구 | 결과 |
|---|---|
| Node.js API 서버 (`server/`, `npm start`) | 완료 · 외부 패키지 0개 |
| 파일 기반 영속 DB (원자적 저장·잠금) | 완료 · `server/data/db.json` |
| 제휴 신청/승인 이력/승인 골프장 모델, `PA-YYMMDD-NNNN` | 완료 |
| 신청·조회·공개 목록·관리자 API | 완료 (아래 4장) |
| 관리자 서버 인증(세션/토큰), localStorage 만으로 권한 불가 | 완료 · HMAC 토큰 + HttpOnly 쿠키, 매 요청 검증 |
| 비밀값 환경변수화 + `.env.example` + `.gitignore` | 완료 · 미설정 시 "시연용 기본값" 명시 |
| 중복 승인·반려, 경쟁 상태 차단(409) | 완료 · 잠금 안 재확인 + 동시 10건 테스트 |
| 프론트 서버 연동 + 정적 시연 폴백, 콘솔 오류 0 | 완료 · 서버 없으면 네트워크 요청 0건 |
| 모드(서버 연동/정적 시연) UI 표시 | 완료 · 전 화면 좌하단 배지 + 관리자 화면 배너 |
| 기존 회귀 120개 유지 | **120/120 통과** |
| 6단계 전용 테스트 | **90/90 통과** |
| `main` 머지·배포 | 완료 · PR #9 머지, GitHub Pages 재빌드 |

---

## 2. 백엔드 기술 선정 이유

**Node.js 내장 모듈만 사용하는 제로 디펜던시 서버**를 선택했습니다.

1. **집 Windows PC에서 바로 실행**
   - `package.json` 의 `dependencies` 가 비어 있어 `npm install` 자체가 필요 없습니다.
   - `better-sqlite3`, `bcrypt`, `sharp` 처럼 C++ 컴파일러(Visual Studio Build Tools)를 요구하는 네이티브 모듈을 쓰지 않습니다.
   - Node.js 18+ 만 설치되어 있으면 `npm start` 또는 `start-server.bat` 더블클릭으로 실행됩니다.
2. **설치·버전 잠금 문제 제거**
   - `node_modules`, lockfile, npm 레지스트리 접근 없이 동작합니다(사내망·오프라인에서도 실행 가능).
3. **파일 DB(JSON) + 원자적 쓰기**
   - 데이터 규모가 작은 시연 단계(제휴 신청 수십~수백 건)에서는 SQLite 서버 없이도 충분하며, 백업이 파일 복사 한 번으로 끝납니다.
   - 쓰기는 `임시 파일 → fsync → rename` 순서로 수행해 전원이 꺼져도 반쯤 쓰인 JSON이 남지 않습니다.
   - 프로세스 내 요청 큐 + `db.json.lock` 파일 잠금으로 **동시에 두 요청/두 프로세스가 같은 데이터를 덮어쓰지 못하게** 합니다.
   - JSON이 깨진 경우 조용히 초기화하지 않고, 손상 파일 사본과 최신 백업 경로를 알려주며 서버를 멈춥니다(데이터 보존 우선).
   - 한계: 다중 서버 인스턴스/대용량 트래픽에는 부적합합니다. 7단계 이후 실제 트래픽이 생기면 PostgreSQL/MySQL + 마이그레이션으로 이전하는 것을 전제로 했습니다(10장).
4. **정적 사이트와의 공존**
   - 같은 서버가 정적 파일(앱·관리자 화면)과 `/api` 를 함께 서빙해 오리진이 하나이므로 CORS·쿠키 문제가 없습니다.
   - GitHub Pages 에서는 서버가 없으므로 프론트가 자동으로 기존 localStorage 시연 모드로 돌아갑니다.

---

## 3. DB 구조와 백업·복구

### 3.1 파일

| 경로 | 설명 | Git |
|---|---|---|
| `server/data/db.json` | 실행 중 데이터(신청·승인 골프장·이력) | 제외 |
| `server/data/db.seed.json` | 빈 DB 시드(없을 때 이 내용으로 생성) | 포함 |
| `server/data/backups/db-YYYY-MM-DD.json` | 하루 1회 자동 스냅샷 | 제외 |
| `server/data/db.json.lock` | 동시 쓰기 잠금 | 제외 |

### 3.2 스키마

```json
{
  "version": 1,
  "meta": {
    "createdAt": "ISO", "updatedAt": "ISO", "revision": 12,
    "sequences": { "261124": 3 },
    "lastBackupDate": "2026-11-24"
  },
  "applications": [
    {
      "id": "PA-261124-0001",
      "status": "pending | approved | rejected",
      "courseMode": "existing | new",
      "courseId": "cn-gcz-cheonan",         // 기존 골프장
      "newCourseId": "ap-...",              // 신규 골프장
      "course": { "name": "", "region": "", "city": "", "address": "", "phone": "", "website": "", "holes": "", "operationType": "public" },
      "manager": { "name": "", "role": "", "phone": "", "email": "" },
      "conditions": { "weekdayGreenFee": 160000, "weekendGreenFee": null, "cartFee": null, "caddieFee": null, "teeInterval": 8, "memo": "" },
      "lookupCodeHash": "sha256(6자리코드|접수번호)",
      "agreeAt": "ISO", "decision": { "at": "ISO", "by": "admin@allgolf.demo", "memo": "", "reason": "" },
      "createdAt": "ISO", "updatedAt": "ISO", "dataMode": "demo"
    }
  ],
  "approvedCourses": [
    {
      "id": "ap-... | 기존 courseId",
      "applicationId": "PA-261124-0001",
      "name": "", "region": "", "city": "", "address": "",
      "operationType": "public", "holes": 18, "phone": "", "website": "",
      "source": "existing | new",
      "greenFee": { "weekday": 160000, "weekend": null, "cart": null, "caddie": null, "teeInterval": 8 },
      "approvedAt": "ISO", "approvedBy": "admin@allgolf.demo",
      "createdAt": "ISO", "updatedAt": "ISO"
    }
  ],
  "auditLogs": [
    {
      "id": "AL-...", "at": "ISO",
      "action": "application.created | application.approved | application.rejected | admin.login",
      "applicationId": "PA-...", "courseId": "", "courseName": "",
      "actor": { "type": "partner | admin", "email": "", "ip": "" },
      "fromStatus": "pending", "toStatus": "approved",
      "memo": "", "reason": ""
    }
  ]
}
```

- 접수번호는 **한국 시간** 기준 `PA-YYMMDD-NNNN` 이며, 일자별 순번을 `meta.sequences` 에 보관합니다(재시작해도 이어짐).
- 조회 코드는 6자리 숫자를 발급 시 **한 번만** 응답하고 DB에는 `sha256(코드|접수번호)` 만 저장합니다.
- 공개 목록(`/api/partner-courses`)은 `approvedCourses` 에서 담당자 정보·메모·해시를 제외한 필드만 내보냅니다.

### 3.3 백업

```bash
npm run db:backup      # backups/db-YYYY-MM-DD-HHMMSS-manual.json
```
- 서버가 그날 처음 데이터를 수정할 때 자동으로 `backups/db-YYYY-MM-DD.json` 을 남깁니다.
- `db.json` 파일 하나가 전체 데이터이므로 탐색기에서 복사해도 백업이 됩니다.

### 3.4 복구

```bash
npm run db:restore -- server/data/backups/db-2026-11-24.json
```
- 복구 전 현재 DB는 `backups/db-before-restore-*.json` 으로 자동 보존합니다.
- JSON 손상 시 서버는 `db.json.corrupt-<시각>.json` 사본을 만들고 시작을 중단하며, 복구 명령을 안내합니다.

### 3.5 초기화(시연용)

```bash
npm run db:reset-demo    # "RESET" 입력 필요, 초기화 전 백업 자동 생성
```

---

## 4. API 목록

공통: JSON, `Content-Type: application/json`, 실패 시 `{ "ok": false, "error": { "code", "message", "details?" } }`.
관리자 API는 `Authorization: Bearer <token>` 또는 `allgolf_admin` HttpOnly 쿠키가 필요합니다.

| Method | Path | 인증 | 설명 |
|---|---|---|---|
| GET | `/api/health` | — | 서버·DB 상태, 버전, 인증 모드, 건수 |
| GET | `/api/partner-courses` | — | 승인된 제휴 골프장 공개 목록(민감정보 제외) |
| GET | `/api/partner-courses/:id` | — | 승인 골프장 1곳 |
| GET | `/api/partner-courses/:id/tee-times?date=YYYY-MM-DD` | — | 승인 골프장의 시연 티타임(날짜별 고정 규칙) |
| POST | `/api/partner-applications` | — | 제휴 신청 접수 → `201` + `application`, `lookupCode` |
| GET | `/api/partner-applications/:id?code=NNNNNN` 또는 `?phone=010...` | 조회 코드/연락처 | 본인 신청 상태 조회 |
| POST | `/api/admin/login` | — | 관리자 로그인 → 서명 토큰 + HttpOnly 쿠키 |
| POST | `/api/admin/logout` | 토큰 | 로그아웃(토큰 폐기) |
| GET | `/api/admin/session` | 토큰 | 세션 유효성 확인 |
| GET | `/api/admin/partner-applications?status=&q=&limit=` | 토큰 | 신청 목록 + 통계 |
| GET | `/api/admin/partner-applications/:id` | 토큰 | 신청 상세 |
| POST | `/api/admin/partner-applications/:id/approve` | 토큰 | 승인(`memo` 선택) → 공개 목록 반영 + 이력 |
| POST | `/api/admin/partner-applications/:id/reject` | 토큰 | 반려(`reason` 필수) + 이력 |
| GET | `/api/admin/audit-logs?applicationId=&action=&limit=` | 토큰 | 처리 이력 |
| GET | `/api/admin/stats` | 토큰 | 건수 요약 |
| GET | `/api/events` | — | SSE: `partner-courses.changed`, `application.decided` |

### 상태 코드 규칙

| 코드 | 상황 |
|---|---|
| 400 | 입력 검증 실패(`details.errors` 에 필드별 메시지), 반려 사유 없음, 잘못된 날짜 |
| 401 | 관리자 토큰 없음·위조·만료·로그아웃됨, 로그인 실패 |
| 403 | 타인 신청 조회(조회 코드/연락처 불일치) |
| 404 | 없는 신청/골프장 |
| 409 | 중복 신청, 중복 승인·반려(이미 처리됨), 이미 제휴 중인 골프장 |
| 429 | 로그인·조회 시도 과다 |

### 예시

```bash
# 신청 접수
curl -X POST http://127.0.0.1:4173/api/partner-applications \
  -H "Content-Type: application/json" \
  -d '{"courseMode":"new","courseName":"테스트 CC","region":"경기","city":"이천",
       "managerName":"김담당","managerPhone":"010-1234-5678","managerEmail":"a@b.com",
       "weekdayGreenFee":"160000","agree":true}'
# → 201 {"ok":true,"application":{"id":"PA-261124-0001",...},"lookupCode":"123456"}

# 본인 조회
curl "http://127.0.0.1:4173/api/partner-applications/PA-261124-0001?code=123456"

# 관리자 로그인 후 승인
TOKEN=$(curl -s -X POST http://127.0.0.1:4173/api/admin/login \
  -H "Content-Type: application/json" -d '{"password":"<ADMIN_PASSWORD>"}' | jq -r .token)
curl -X POST http://127.0.0.1:4173/api/admin/partner-applications/PA-261124-0001/approve \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"memo":"서류 확인"}'
```

---

## 5. 인증·권한·동시성

- **서버 측 인증**: 비밀번호는 `ADMIN_PASSWORD` 환경변수에서만 읽고, 로그인 시 HMAC-SHA256 서명 토큰(8시간)을 발급합니다.
  모든 관리자 API가 서명·만료·폐기 여부를 검사하므로, 브라우저 `localStorage` 에 값을 넣어도 승인 권한을 얻을 수 없습니다.
- **쿠키**: `HttpOnly; SameSite=Lax; Path=/` (+ HTTPS 시 `Secure`). 토큰은 `sessionStorage` 에도 두어 원격 서버(`?api=`) 사용 시 Authorization 헤더로 보냅니다.
- **비밀값**: `.env`(git 제외) / `.env.example` 제공. 미설정 시 시연용 기본 비밀번호로 실행되고 시작 로그에 경고가 출력됩니다.
  `SESSION_SECRET` 미설정 시 시작할 때마다 임의 키를 생성하므로 재시작하면 관리자 세션이 만료됩니다(의도된 동작).
- **타인 조회 차단**: 접수번호만으로는 조회할 수 없고, 발급된 6자리 조회 코드 또는 등록된 담당자 연락처가 일치해야 합니다. 실패는 접수번호+IP 기준 10분 30회로 제한합니다.
- **중복·경쟁 상태**: 신청은 잠금 안에서 한 번 더 중복을 확인해 409, 승인/반려는 상태가 `pending` 이 아니면 409.
  동시에 10건을 승인 요청해도 1건만 성공하는 것을 테스트로 확인했습니다.
- **정적 서빙 차단**: `/server/`, `.env`, `.git` 등은 404로 가리고, 퍼센트 인코딩(`/server%2F...`) 우회도 차단합니다.
- **공개 채널 최소화**: 공개 골프장 목록과 SSE 이벤트에는 제휴 신청 접수번호·담당자 정보·메모를 싣지 않습니다(접수번호는 관리자 API와 본인 조회에만 사용).

---

## 6. 프론트엔드 연동과 모드

| 파일 | 역할 |
|---|---|
| `data/api-client.js` | API 주소 결정·헬스 체크·모드 전환·요청 래퍼(예외를 던지지 않음) |
| `data/partner-sync.js` | 승인 골프장 캐시 동기화(5초 폴링 + SSE), `allgolf:partnerschange` 이벤트, 모드 배지 |
| `data/partner-application.js` | 기존 localStorage 저장소에 서버 승인 골프장을 합쳐 `partnerIds`·`approvedCourses`·`demoTimesFor` 확장 |

- **서버 모드 판별**: 서버가 HTML을 서빙할 때 `window.ALL_GOLF_SERVER_MODE=true` 를 주입합니다. GitHub Pages 에는 이 플래그가 없으므로 **요청을 보내기 전에** 정적 모드로 결정됩니다 → 콘솔 오류 0건.
- **원격 서버 연결**: `?api=https://주소` 로 한 번 열면 브라우저에 기억됩니다. 서버에는 `ALLGOLF_ALLOWED_ORIGINS` 로 그 출처를 허용해야 합니다.
- **화면 반영**: 본사 승인 → `partner-courses.changed` SSE/폴링 → `allgolf:partnerschange` → 사용자 앱·골프장 관리자 목록이 새로고침 없이 갱신됩니다.
- **모드 표시**: 모든 화면 좌하단에 `● 서버 연동` / `○ 정적 시연` 배지, 본사 관리자 화면 상단에 설명 배너.

---

## 7. 집 Windows PC에서 실행하는 방법

```powershell
cd <저장소 폴더>
git pull
npm start
```
또는 탐색기에서 `start-server.bat` 더블클릭.

- **`npm install` 은 필요 없습니다** (외부 패키지 0개, C++ 빌드 없음).
- Node.js 가 없으면 <https://nodejs.org> LTS 설치 후 다시 실행합니다.
- 접속 주소
  - 사용자 앱: <http://127.0.0.1:4173/>
  - 골프장 관리자: <http://127.0.0.1:4173/partner/>
  - 본사 관리자: <http://127.0.0.1:4173/admin/>
  - 상태 확인: <http://127.0.0.1:4173/api/health>
- 관리자 비밀번호
  1. `.env.example` 을 `.env` 로 복사
  2. `ADMIN_PASSWORD=원하는비밀번호` 입력 (같은 파일에서 `SESSION_SECRET` 도 32자 이상 권장)
  3. `npm start` 재실행
  - 설정하지 않으면 시연용 기본값 `allgolf-demo-2026` 으로 실행되고 로그에 경고가 나옵니다.
- 포트 변경: `PORT=8080 npm start` (PowerShell: `$env:PORT=8080; npm start`)
- 같은 공유기의 휴대폰에서 접속: `HOST=0.0.0.0 npm start` 후 표시되는 `http://192.168.x.x:4173/` (시연용, 외부 공개 금지)
- 데이터 위치: `server/data/db.json` (백업 `server/data/backups/`)
- 종료: 창에서 `Ctrl+C`

---

## 8. 테스트 결과

실행:

```bash
node tests/run-scenarios.js        # 기존 회귀
node tests/run-server-scenarios.js # 6단계 (임시 DB로 실제 서버 기동)
npm test                           # 위 두 개 한 번에
```

| 구분 | 결과 |
|---|---|
| 기존 회귀(1~5단계) | **120/120 통과, 0 실패** |
| 6단계 서버·DB | **90/90 통과, 0 실패** |

6단계에서 검사한 항목:

- 서버 기동, `/api/health`, 정적 앱 동시 서빙, 서버 모드 플래그 주입
- DB 파일·`.env` 직접 접근 차단(인코딩 우회 포함)
- 신청 검증(연락처·지역·골프장·동의), 접수번호 형식, `createdAt/updatedAt`
- 같은 골프장/같은 이름 중복 신청 409
- 컨텍스트 A 본인 조회 200, 코드 없음/틀린 코드 403, 없는 번호 404, 연락처 조회 200
- 컨텍스트 B: 인증 없는 목록·승인·반려 401, 위조 토큰 401, 틀린 비밀번호 401, 정상 로그인·세션·목록
- 승인 → 상태·처리자·일시 기록, 중복 승인 409, 승인 건 반려 409, 반려 사유 필수 400
- 공개 목록에 담당자 이름·전화·이메일·메모 없음, 대표 전화는 포함
- 승인 골프장 시연 티타임 5개, 잘못된 날짜 400
- 처리 이력: 접수/승인 기록, 처리자 이메일, 접수번호 필터, 인증 없음 401
- 동시 승인 10건 → 성공 1 / 409 9
- 서버 재시작 후 신청 건수·승인 상태·공개 수·조회 코드·이력 유지
- 정적 호스팅: 네트워크 요청 **0건**으로 정적 모드, 모드 표기, 서버 꺼짐 시에도 예외 없이 폴백
- 컨텍스트 C: 실제 앱 코드에서 승인 골프장 `bookable=true`, 시연 티타임 노출, `reserveTee` 성공, 승인 전 골프장은 제휴 아님

추가로 브라우저 없이 실제 화면 코드를 실행하는 스모크 점검을 했습니다(커밋에는 포함하지 않음).

- 관리자(서버 모드): 로그인 화면 → 로그인 → 콘솔 → 신청 목록·이력 로드 → 상세 모달
- 골프장 관리자(서버 모드): 로그인 → 신청 폼 → 접수 완료(접수번호·조회 코드 표시) → 상태 조회(승인 완료 표시)
- 정적 모드: 세 화면 모두 렌더링, `fetch` 호출 0회, 배지 `정적 시연`
- 사용자 앱(정적): 기존 제휴 68곳 예약 가능 유지

---

## 9. 외부 배포 절차

### 9.1 GitHub Pages (정적 시연)

- `main` 브랜치 루트를 그대로 배포합니다(`.nojekyll` 유지). 서버·DB 파일은 `.gitignore` 로 제외되어 올라가지 않습니다.
- 방문자는 자동으로 **정적 시연 모드**가 되며, 배지로 구분됩니다.
- 배포 확인: <https://neved12.github.io/all-golf-test/> HTTP 200, 새 스크립트(`api-client.js`, `partner-sync.js`) 로드, 콘솔 오류 0.

### 9.2 서버를 외부에 공개할 때

1. 서버 실행 (예: 사내 PC, NAS, 작은 VPS)
   ```bash
   ADMIN_PASSWORD=강한비밀번호 SESSION_SECRET=32자이상임의문자열 HOST=0.0.0.0 PORT=4173 npm start
   ```
2. HTTPS 뒤에 둡니다(리버스 프록시 또는 `cloudflared tunnel` 같은 터널). HTTPS면 `ALLGOLF_SECURE_COOKIE=1`.
3. 정적 페이지에서 붙일 때 `https://neved12.github.io/all-golf-test/?api=https://<서버주소>` 로 접속.
4. 서버에 `ALLGOLF_ALLOWED_ORIGINS=https://neved12.github.io` 를 지정합니다(쉼표로 여러 개).
5. 점검 체크리스트
   - `/api/health` 200, `auth.mode=env`
   - 관리자 로그인 후 승인/반려가 200, 인증 없이 401
   - `/server/data/db.json`, `/.env` 접근 404
   - `server/data/backups/` 에 일별 백업 생성
   - 방화벽: 필요한 포트만, 시연 후 종료
6. 개인정보(담당자 연락처)가 들어가므로 **공개 인터넷에 무기한 노출하지 말 것**. 시연 종료 시 `db.json` 삭제 또는 `npm run db:reset-demo`.

---

## 10. 7단계(골프장별 티타임·운영 관리) 이관 대상

이번 단계는 제휴 신청·승인 데이터만 서버로 옮겼습니다. 다음 단계에서 서버로 옮길 대상과 준비 사항입니다.

| 대상 | 현재 | 7단계 이관 방향 |
|---|---|---|
| 골프장별 티타임·잔여 팀 | 브라우저 localStorage(`allGolfOperationsV1`) | `teeTimes` 테이블(골프장·날짜·시간·가격·잔여·마감), 서버 API + 골프장 관리자 인증 |
| 예약·취소·환불 | localStorage(`allGolfReservations`) | `reservations` 테이블, 좌석 차감 트랜잭션(잠금), 예약번호 발급을 서버로 |
| 특가·요금·취소 정책 | localStorage | `rates`, `specialOffers` 테이블, 승인 워크플로 |
| 골프장 관리자 계정 | 골프장 선택만(인증 없음) | 골프장별 계정·역할(최고/예약/가격/일반), 승인된 골프장에만 발급 |
| 대기·알림 | localStorage | 서버 대기열, 알림 발송(문자/푸시) 정책 |
| 정산 | 시연 화면 | 예약·결제 데이터 기반 정산 배치 |
| 외부 연동 | 없음 | 실제 결제(PG), 골프장 예약 API, 알림 발송 — 별도 계약·키 관리 |
| DB | JSON 파일 | PostgreSQL/MySQL 등 RDB + 마이그레이션, 트랜잭션·백업 정책 |
| 감사·권한 | 관리자 1계정 | 관리자 계정별 권한·감사 로그(현재 `auditLogs` 구조 확장) |

**이관 시 지켜야 할 것**

- 6단계의 접수번호·승인 골프장 ID(`ap-...`)를 그대로 유지해 기존 승인 데이터와 연결.
- `approvedCourses` 를 골프장 마스터의 `partner` 상태 원천으로 삼고, 사용자 앱의 기본 제휴 68곳 규칙을 데이터로 이동.
- 좌석 차감은 반드시 서버 트랜잭션 + 낙관적/비관적 잠금으로 처리(현재 파일 잠금과 같은 원칙).
- 개인정보(담당자 연락처) 암호화·접근 로그·보존 기간 정책 수립.

---

## 11. 알려진 한계

- 시연용 데이터입니다. 실제 결제·실예약·정산은 없습니다.
- 파일 DB는 단일 서버 프로세스 기준입니다(여러 대 동시 운영은 7단계 RDB 이관 후).
- 감사 로그는 10,000건에서 오래된 항목을 정리합니다.
- 관리자 계정은 환경변수 1개입니다(다중 계정·권한은 7단계).
- GitHub Actions 워크플로는 저장소 앱 권한(`workflows`) 제한으로 추가하지 못했습니다. 테스트는 `npm test` 로 언제든 실행할 수 있습니다.

---

## 12. 변경 파일

```
.env.example                      환경변수 예시(실제 값 아님)
.gitignore                        DB·백업·.env 제외
README.md                         실행·구조 안내
package.json                      start/test/db 스크립트, 의존성 없음
start-server.bat / .sh            Windows·macOS 실행
server/index.js                   HTTP 서버(정적+API, 셧다운)
server/lib/config.js              .env 로더·설정
server/lib/catalog.js             기존 data/*.js 마스터를 vm으로 로드
server/lib/db.js                  파일 DB·원자적 쓰기·잠금·백업
server/lib/domain.js              검증·접수번호·조회 코드·공개 변환·시연 티타임
server/lib/auth.js                관리자 비밀번호·HMAC 토큰·시도 제한
server/lib/http.js                JSON·본문·CORS·보안 헤더·정적 서빙·SSE
server/routes/api.js              API 라우팅
server/scripts/{backup,restore,reset-demo}.js
server/data/db.seed.json, README.md
data/api-client.js                프론트 API 클라이언트·모드 판별
data/partner-sync.js              서버 승인 골프장 동기화·모드 배지
data/partner-application.js       서버 승인분 합치기
partner/index.html, partner.js, partner.css    서버 접수·조회 코드·모드 표시
admin/index.html, admin.js, admin.css          서버 로그인·승인·반려·이력
index.html                        새 스크립트 로드
tests/run-server-scenarios.js     6단계 테스트 89개
tests/README.md                   테스트 안내
```

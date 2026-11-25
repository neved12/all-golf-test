# ALL:GOLF (시연용)

골프장 검색·시연 예약 앱, 골프장 관리자(`/partner/`), 본사 관리자(`/admin/`)로 구성된 **시연용** 프로젝트입니다.
실제 결제·실제 골프장 예약·외부 골프장 API 연동은 없습니다.

- 정적 사이트: <https://neved12.github.io/all-golf-test/> — 서버 없이 **정적 시연 모드**로 동작합니다.
- 서버 실행 시: 같은 주소에서 앱과 API·DB가 함께 동작합니다(8단계: 서버 예약·실시간 재고).

## 빠른 시작 (Windows 집 PC 포함)

```bash
git pull
npm start            # = node server/index.js
```

Windows에서는 `start-server.bat` 더블클릭으로도 실행됩니다.
**`npm install` 은 필요하지 않습니다** — 외부 패키지와 네이티브 모듈(C++ 컴파일러)을 쓰지 않습니다. Node.js 18 이상만 있으면 됩니다.

| 화면 | 주소 |
|---|---|
| 사용자 앱 | <http://127.0.0.1:4173/> |
| 골프장 관리자 | <http://127.0.0.1:4173/partner/> |
| 본사 관리자 | <http://127.0.0.1:4173/admin/> |
| API 상태 | <http://127.0.0.1:4173/api/health> |

### 관리자 계정

- 본사 관리자: 환경변수 `ADMIN_PASSWORD` 로 지정합니다.
  지정하지 않으면 **시연용 기본 비밀번호 `allgolf-demo-2026`** 으로 실행되고 시작 로그에 경고가 표시됩니다.
  이 값은 저장소에 공개된 시연용 값이며 실제 운영 계정이 아닙니다.
- 골프장 담당자: 본사 관리자 화면 → **제휴 계정 관리**에서 제휴 승인된 골프장별로 발급합니다(초기 비밀번호는 1회 표시).
  시연 편의를 위해 아래 명령으로 승인 골프장마다 계정을 한 번에 만들 수도 있습니다.

  ```bash
  npm run demo:partner-accounts            # 시연용 기본 비밀번호 allgolf-partner-2026
  npm run demo:partner-accounts -- 원하는비밀번호
  ```

  또는 서버를 `ALLGOLF_SEED_DEMO_PARTNER_ACCOUNTS=1` 로 실행하면 승인 골프장에 계정이 자동 생성됩니다(시연 전용).
  계정 비밀번호는 scrypt 해시로만 저장되며 평문은 DB·Git에 남지 않습니다.

### 환경변수

`.env.example` 을 `.env` 로 복사해 값을 채웁니다(`.env` 는 Git 에 올라가지 않습니다).
`ADMIN_PASSWORD`, `SESSION_SECRET`, `PARTNER_SESSION_TTL_HOURS`, `DEMO_PARTNER_PASSWORD`,
`ALLGOLF_SEED_DEMO_PARTNER_ACCOUNTS` 등을 설명과 함께 제공합니다.

## 모드

| 모드 | 조건 | 동작 |
|---|---|---|
| 서버 연동 | `npm start` 로 연 서버에서 접속 | 제휴 신청·승인, 골프장별 담당자 계정, 티타임·요금·특가가 서버 DB에 저장·공유. 모든 운영 API는 서버 세션으로 권한 검증 |
| 정적 시연 | GitHub Pages 등 서버 없이 접속 | 네트워크 요청 없이 기존 localStorage 시연 모드. 화면 왼쪽 아래 배지로 구분 |

원격 서버에 붙이려면 `?api=https://주소` 로 한 번 접속합니다(설정은 브라우저에 기억됨).
서버 쪽에서 `ALLGOLF_ALLOWED_ORIGINS` 에 그 출처를 추가해야 합니다.

## 8단계에서 달라진 점 (서버 예약 엔진)

- **임시확보(Hold)**: 고객이 결제 화면을 열면 서버가 5분간 1팀을 잡아 둡니다(TTL 만료 시 자동 해제·재고 복구).
- **원자적 예약 확정**: 파일 DB 잠금 안에서 잔여 팀을 검증·차감합니다. 같은 티타임에 동시에 여러 명이 예약해도
  마지막 1팀은 정확히 한 건만 성공하고 나머지는 `409 Conflict`로 막힙니다(Overbooking 방지).
- **멱등 키**: `Idempotency-Key` 헤더로 중복 클릭·재전송을 막습니다. 같은 키는 이중 차감 없이 동일 예약을 돌려줍니다.
- **예약 조회·취소·환불**: 예약번호(`AG-YYMMDD-NNNNN`) + 예약자 연락처로 조회하고, 서버가 취소·환불 규정으로
  수수료·환불액을 계산합니다. 취소 즉시 잔여 팀이 복구됩니다.
- **실시간 재고 공유**: 고객 앱은 `inventoryLinked:true`로 전환되어 서버 재고를 그대로 표시하고, SSE로 즉시 갱신합니다.
  여러 기기·브라우저가 같은 잔여 팀을 봅니다. 서버가 없는 GitHub Pages에서는 기존 localStorage 시연 모드(요청 0건)로 폴백합니다.
- **골프장·본사 콘솔**: 담당자는 자기 골프장 예약만 조회·상태 처리(타 골프장 `403`), 본사는 전체 예약·취소·환불과 감사 로그를 봅니다.
- **DB 스키마 v3**: 기존 v1/v2 `db.json`은 읽을 때 자동 보완되어 그대로 사용됩니다.
- 실제 PG 결제 승인·실골프장 API·회원가입·정산은 여전히 범위 밖입니다(9단계).

## 7단계에서 달라진 점

- **골프장별 담당자 계정**: 제휴 승인된 골프장에만 계정 발급, 서버 로그인/로그아웃, 계정 비활성화·권한 변경 시 기존 세션 즉시 무효화.
- **데이터 격리**: 담당자는 자기 골프장의 티타임·요금·특가만 조회·수정할 수 있습니다. 다른 골프장 ID로 요청하면 `403`.
- **티타임 서버 CRUD**: 코스·날짜·시간·부·예약 가능 팀·최대 인원·기본 그린피·상태. 중복 등록과 수정 충돌(`409`, version) 방어,
  예약·임시확보·특가가 연결된 티타임 삭제 차단.
- **요금·특가 서버 CRUD**: 기본/3인/4인 그린피, 카트·캐디·예약금, 특가 금액·판매 기간·적용 팀·노출 여부와 할인율 계산.
- **고객 앱 반영**: 서버에 등록된 티타임·특가를 API 우선으로 조회하고 SSE/폴링으로 갱신합니다. 서버가 없으면 요청 0건의 정적 시연으로 자동 폴백합니다.
  예약 재고는 8단계에서 서버로 이전되었습니다.
- **본사 관리자**: 제휴 계정 관리(생성·활성/비활성·비밀번호 재설정), 골프장별 티타임·특가 운영 현황, 계정·데이터 변경 감사 로그.

## 테스트

```bash
npm test                              # 아래 네 테스트를 모두 실행
node tests/run-scenarios.js           # 기존 회귀 120개
node tests/run-server-scenarios.js    # 6단계 서버·DB 90개 (임시 DB로 실제 서버 기동)
node tests/run-stage7-scenarios.js    # 7단계 계정·권한·티타임·특가 187개
node tests/run-stage8-scenarios.js    # 8단계 예약·Hold·동시성·멱등·취소·환불 168개
node tests/run-ui-smoke.js            # 화면 스크립트 스모크 33개 (partner/admin 실제 서버 연결)
```

## 폴더

```
index.html, app.js, styles.css   사용자 앱
partner/                         골프장 관리자
admin/                           본사 관리자
data/                            골프장 마스터·시연 재고, 제휴 저장소, API 클라이언트, 서버 카탈로그 동기화
server/                          무의존성 Node API 서버 + 파일 DB
tests/                           브라우저 없이 실행하는 시나리오 테스트
```

## 데이터·백업

- 서버 DB: `server/data/db.json` (Git 제외, 개인정보 포함 가능)
- 자동 백업: 하루 1회 `server/data/backups/db-YYYY-MM-DD.json`
- 수동 백업/복구: `npm run db:backup`, `npm run db:restore -- <파일>`
- 자세한 내용: [`server/data/README.md`](server/data/README.md)

8단계 구현·검증 결과는 [ALLGOLF_8단계_완료보고서.md](ALLGOLF_8단계_완료보고서.md) 에 정리했습니다.
7단계 결과는 [ALLGOLF_7단계_완료보고서.md](ALLGOLF_7단계_완료보고서.md) 에 있습니다.
6단계 결과는 [ALLGOLF_6단계_완료보고서.md](ALLGOLF_6단계_완료보고서.md) 에 있습니다.

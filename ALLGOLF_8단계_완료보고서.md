# ALL:GOLF 8단계 완료 보고서 — 실제 공유 예약 엔진 (서버 예약·원자적 재고 잠금·취소/환불)

- 저장소: `neved12/all-golf-test` (`main`)
- 기준 커밋: `70fa19c` (7단계 완료)
- 작업 브랜치: `feat/stage8-shared-reservation-engine`
- PR: **#15** → 머지 커밋 **`210cc9c86748c7280549659a9e3279eefc5cb7de`**
- 배포: GitHub Pages **built** (https://neved12.github.io/all-golf-test/, HTTP 200)
- 성격: **시연용**. 실제 PG 결제 승인·실제 골프장 예약·외부 골프장 API·정산은 포함하지 않습니다.
- 확인 시각: 2026-11-25 11:26~11:30 (KST)

---

## 1. 요약

| 요구 | 결과 |
|---|---|
| 서버 예약 생성·임시확보(Hold, TTL 만료 자동 해제) | 완료 · `POST /api/public/holds`, TTL 기본 300초(환경변수), 세션당 3건 |
| 파일 DB 잠금 안 원자적 재고 검증·차감 | 완료 · `store.update`(프로세스 큐 + `db.json.lock`) 안에서 `capacityTeams − booked − activeHolds` 검사 |
| 동시/중복 예약 Overbooking 409 방어 | 완료 · 1팀 티타임에 동시 3건 → **1건만 201, 2건 409 `sold_out`** |
| 멱등 키(`Idempotency-Key`) 이중 예약 방지 | 완료 · sha256 저장, 같은 키 재전송은 **200 + 동일 예약번호, 재고 차감 없음** |
| 만료 Hold 즉시/주기 회수·잔여 복구 | 완료 · 조회·예약·취소 시점 + 30초 주기 정리(`expired`), 만료 후 잔여 복구 확인 |
| 예약번호 발급 `AG-YYMMDD-NNNNN` | 완료 · 한국 시간 기준 일자별 순번을 `meta.sequences`(`rsv:YYMMDD`)에 보존 |
| 예약번호 + 연락처 예약 조회/상세 | 완료 · 다른 연락처 403, 없는 예약 404, 조회 시도 제한(429) |
| 서버 취소·환불 상태 관리·재고 복구 | 완료 · `CONFIRMED → CANCELLED`, 환불률·수수료·환불액 계산, 취소 즉시 잔여 복구 |
| 골프장 담당자 예약 상태 변경·취소·감사 로그 | 완료 · 완료/노쇼/취소, 타 골프장 403, 감사 로그 기록 |
| 본사 관리자 전체 예약·취소·환불·감사 로그 | 완료 · 전체 조회·필터, 사유 필수 강제 취소, 환불 계산, 감사 로그 3종 |
| 고객 앱 서버 예약·실시간 재고 우선(`inventoryLinked:true`) | 완료 · 서버 잔여 그대로 사용, SSE(`inventory.changed`/`reservations.changed`) 즉시 갱신 |
| 서버 미연결(GitHub Pages) 정적 폴백 유지 | 완료 · 실브라우저에서 `/api/` 요청 **0건**, 배지 `○ 정적 시연` |
| DB 스키마 v3(v1/v2 자동 호환) | 완료 · 기존 DB 읽을 때 보완, v2 → v3 승격 테스트 |
| 정적 자산 캐시 갱신 | 완료 · 세 화면 모두 `?v=20261125-stage8` |
| 기존 테스트 유지 | 120 + 90 + 187 = 397 전부 통과(7단계 4건은 8단계 변경에 맞춰 기대값만 갱신, 검사 수 동일) |
| 8단계 신규 테스트 | **168/168 통과** |
| 화면 스크립트 스모크 | **33/33 통과** (예약 관리·취소·전체 예약 추가) |
| PR·main 병합·Pages 배포 | 완료 · PR #15, `210cc9c`, Pages `built`, HTTP 200 |

---

## 2. 구현 방식과 설계 판단

### 2.1 재고를 "계산"으로 바꾼 이유

7단계까지 `teeTimes.bookedTeams`/`heldTeams`는 숫자 필드였고 실제 예약과 연결되지 않았습니다.
8단계에서는 예약(`reservations`)과 임시확보(`bookingHolds`) 컬렉션을 진실로 두고 잔여를 계산합니다.

```
잔여 팀 = capacityTeams
        − (티타임에 저장된 bookedTeams + status ∈ {confirmed, completed, no_show} 예약 수)
        − (TTL 이 살아 있는 Hold 수)
```

- **취소만** 재고를 비웁니다. 이용 완료·노쇼는 그 라운드의 팀을 점유한 것으로 봅니다(당일 중복 판매 방지).
- `bookedTeams`/`heldTeams` 필드는 7단계 데이터·수동 보정용으로 남겼습니다(0이면 영향 없음).
- 이중 차감을 막기 위해, 서버 연동 고객 앱은 더 이상 브라우저 예약 수를 빼지 않습니다.

### 2.2 원자성은 라우터가 아니라 저장 계층에서

모든 재고 변경은 `store.update(mutator)` 안에서 일어납니다. 이 함수는

1. 프로세스 내 큐로 요청을 직렬화하고,
2. `db.json.lock` 파일 잠금을 잡고,
3. 최신 DB를 다시 읽은 뒤,
4. 변경분을 임시 파일 + fsync + rename 으로 원자적 교체합니다.

그래서 HTTP 요청이 동시에 들어와도 "읽고-검사하고-쓰는" 구간이 겹치지 않습니다.
멱등 키 조회, Hold 소비, 예약번호 발급도 같은 구간 안에서 처리됩니다.

### 2.3 마지막 1팀과 Hold 소유권

Hold 는 "이 세션이 이 티타임의 1팀을 잡고 있다"는 뜻이므로, 재고 계산에서 이미 빠져 있습니다.
그래서 **Hold 로 확정하는 요청**은 `remaining < 1` 이어도 성공해야 합니다(자기 몫).
코드에서는 `remaining < 1 && !hold → 409` 로 구분했습니다. 이 규칙이 없으면 마지막 1팀을 잡은
사용자가 결제를 끝낼 수 없는 버그가 됩니다.

### 2.4 멱등 키

- 클라이언트가 `Idempotency-Key`(또는 `body.idempotencyKey`)를 보내면 서버는 **sha256 해시만** 저장합니다.
- 같은 해시 + 같은 세션의 기존 예약이 있으면 새 예약을 만들지 않고 `200 { idempotent:true, reservation:기존 }` 을 돌려줍니다.
- 원문 키는 DB·로그에 남기지 않습니다.

### 2.5 취소·환불

- 취소 시점에 골프장 요금 설정(`rates.cancellationPolicy`)을 읽어 계산합니다.
  기본값: 7일 전 100% · 4~6일 전 70% · 2~3일 전 50% · 1일 전 0% · 당일 0%, 취소 기한 없음.
- 라운드일까지 남은 날짜(`daysBefore`)로 환불률을 정하고, `환불액 = round(예약금 × 환불률/100)`,
  `취소수수료 = 예약금 − 환불액` 을 예약 레코드에 남깁니다.
- `cutoffHoursBefore` 가 설정된 골프장은 티오프 N시간 전이 지나면 **고객 셀프 취소는 409**,
  담당자·본사는 사유를 남기고 강제 취소할 수 있습니다.
- 예약 확정 시점의 정책을 `cancellationPolicySnapshot` 으로 보존해, 이후 정책이 바뀌어도 기존 예약은
  확정 당시 기준으로 안내·계산됩니다(기존 앱 로직과 동일한 규칙).

### 2.6 개인정보 처리

- 예약에는 예약자 이름·휴대전화번호가 들어갑니다. `db.json` 은 `.gitignore` 로 Git 에 올라가지 않습니다.
- 저장은 숫자만(`01012345678`) 남기고, 응답은
  - 본인 확인(예약번호 + 연락처 일치) 또는 예약 생성 응답: 전체 번호
  - 그 외 공개 응답: `010-****-5678` 마스킹
- 예약 조회·취소는 IP+예약번호 기준 10분 20회로 제한합니다(무차별 대입 완화).
- 본사·담당자 응답에는 전체 연락처가 필요하므로 포함되지만, 공개 API 에는 계정·세션·멱등 해시가 나가지 않습니다.

### 2.7 정적 모드(시연) 보존

GitHub Pages 처럼 서버가 없는 곳에서는 `data/api-client.js` 가 정적 모드로 남고,
`data/server-reservations.js` 의 모든 함수가 즉시 `static_mode` 로 반환합니다.
`app.js` 의 예약은 기존 `localStorage` 경로(`reserveLocal`)를 그대로 사용하며 네트워크 요청이 0건입니다.

---

## 3. DB 구조 (스키마 버전 3)

`server/data/db.json` (Git 제외) / 시드 `server/data/db.seed.json` (Git 포함)

```json
{
  "version": 3,
  "meta": { "createdAt": "", "updatedAt": "", "revision": 0, "sequences": { "rsv:261125": 5 }, "lastBackupDate": "" },
  "applications": [],
  "approvedCourses": [],
  "partnerAccounts": [],
  "teeTimes": [
    { "id": "tt-...", "courseId": "ap-...", "date": "2026-11-25", "time": "07:30", "session": "1부",
      "capacityTeams": 3, "maxPlayers": 4, "greenFee": 160000, "status": "open",
      "bookedTeams": 0, "heldTeams": 0, "version": 2 }
  ],
  "rates": {
    "ap-...": {
      "baseGreenFee": 160000, "threePlayerGreenFee": 180000, "fourPlayerGreenFee": 150000,
      "threePlayerSurcharge": 10000, "twoPlayerSurcharge": 5000,
      "cartFee": 110000, "caddieFee": 150000, "depositType": "person", "depositValue": 30000,
      "cancellationPolicy": { "sevenPlus": 100, "fourToSix": 80, "twoToThree": 60, "oneDay": 20, "sameDay": 0, "cutoffHoursBefore": null },
      "version": 2
    }
  },
  "specialOffers": [],
  "reservations": [
    {
      "id": "rsv-...", "number": "AG-261125-00001",
      "courseId": "ap-...", "courseName": "", "teeTimeId": "tt-...",
      "date": "2026-11-25", "dateISO": "2026-11-25", "time": "07:30", "session": "1부",
      "people": 4, "booker": "김골퍼", "phone": "01012345678", "companions": ["박동반"], "request": "",
      "status": "confirmed", "version": 1, "paymentStatus": "demo_paid",
      "pricing": { "baseAppliedGreenFee": 150000, "playerSurcharge": 0, "greenTotal": 600000,
                   "cart": 110000, "caddie": 150000, "totalEstimated": 860000,
                   "paidDeposit": 120000, "onsite": 740000 },
      "appliedGreenFee": 150000, "regularGreenFee": 150000, "paidDeposit": 120000, "totalEstimated": 860000,
      "specialOfferId": null, "specialOfferSnapshot": null,
      "cancellationPolicySnapshot": { "sevenPlus": 100, "fourToSix": 80, "twoToThree": 60, "oneDay": 20, "sameDay": 0 },
      "holdId": "hold-...", "sessionId": "session-...", "idempotencyHash": "sha256(hex)",
      "createdAt": "", "updatedAt": "", "cancelledAt": null,
      "cancelReason": null, "cancellationFee": null, "refundAmount": null, "refundStatus": null,
      "cancellation": {
        "at": "", "by": { "type": "customer|partner|admin" }, "reason": "",
        "daysBefore": 1, "refundRate": 20, "refundAmount": 24000, "cancellationFee": 96000,
        "refundStatus": "demo_refunded"
      }
    }
  ],
  "bookingHolds": [
    { "id": "hold-...", "courseId": "ap-...", "teeTimeId": "tt-...", "date": "2026-11-25", "time": "07:30",
      "people": 4, "sessionId": "session-...", "status": "active|consumed|expired|released",
      "createdAt": "", "expiresAt": "" }
  ],
  "auditLogs": []
}
```

- 기존 `db.json`(버전 1·2)은 읽을 때 빠진 컬렉션을 보완해 **버전 3으로 그대로 사용**합니다(이전 불필요).
- `version` 은 낙관적 잠금(수정 충돌 409)용입니다.
- `bookingHolds` 는 만료 2일 뒤 정리되어 파일이 무한히 커지지 않습니다.
- `idempotencyHash` 는 sha256 만, 평문 키·평문 비밀번호는 저장하지 않습니다.

### 백업·복구·초기화(변경 없음, 건수만 확장)

```bash
npm run db:backup       # backups/db-YYYY-MM-DD-HHMMSS-manual.json
npm run db:restore -- server/data/backups/db-2026-11-24.json
npm run db:reset-demo   # "RESET" 입력, 초기화 전 백업 자동 생성
```

백업·복구·초기화 스크립트가 예약·임시확보 건수도 출력합니다.

---

## 4. API 목록 (8단계 추가분)

공통: JSON, 실패 시 `{ "ok": false, "error": { "code", "message", "details? } }`.

### 4.1 공개(고객 앱)

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/public/catalog?date=&courseId=` | 잔여 팀이 서버 예약·Hold 기준으로 계산된 카탈로그, `inventoryLinked:true`, `cancellationPolicy` 포함 |
| GET | `/api/public/inventory?date=&courseId=` | 날짜별 티타임 잔여·예약·확보 수 실시간 조회 |
| POST | `/api/public/holds` | 임시확보 생성(201) / 같은 세션 재요청은 기존 Hold 연장(200, `reused:true`) |
| DELETE | `/api/public/holds/:id?sessionId=` | Hold 해제(본인 세션만) |
| POST | `/api/public/reservations` | 예약 확정(201). `Idempotency-Key` 재전송은 200 + 동일 예약 |
| GET | `/api/public/reservations?phone=` | 같은 연락처의 서버 예약 목록(최대 50건) |
| GET | `/api/public/reservations/:number?phone=` | 예약 상세 + 취소 예상 환불 |
| POST | `/api/public/reservations/:number/cancel` | 고객 셀프 취소(환불 계산·재고 복구) |

### 4.2 골프장 담당자

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/partner/reservations?date=&from=&to=&status=&q=` | 자기 골프장 예약만(+통계). `courseId` 위조 시 403 |
| GET | `/api/partner/reservations/:id` | 예약 상세(타 골프장 403) |
| POST | `/api/partner/reservations/:id/status` | `completed` / `no_show` / `cancelled`(사유), `version` 충돌 409 |
| GET | `/api/partner/dashboard` | 예약 현황 `source:'server'`, `linked:true`, 임시확보 수 |
| GET | `/api/partner/tee-times` | 잔여 팀이 서버 예약·Hold 기준으로 계산 |
| GET·PUT | `/api/partner/rates` | `cancellationPolicy` 저장·검증(환불률 0~100, 기한 0~720시간) |

### 4.3 본사 관리자

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/admin/reservations?date=&from=&to=&status=&courseId=&q=` | 전체 예약 + 통계 + 활성 Hold 수 |
| GET | `/api/admin/reservations/:id` | 예약 상세(전체 연락처, 취소 견적) |
| POST | `/api/admin/reservations/:id/status` | 강제 취소(사유 필수)·완료·노쇼, `version` 충돌 409 |
| GET | `/api/admin/operations?date=` | 골프장별 예약 건수·취소·환불액 추가 |
| GET | `/api/admin/stats` | 예약 통계(`reservationStats`) 추가 |
| GET | `/api/admin/audit-logs?action=` | `reservation.created` / `reservation.cancelled` / `reservation.status-updated` |

### 4.4 상태 코드

| 코드 | 상황 |
|---|---|
| 400 | 입력 검증 실패(필드별 `details.errors`), 세션 없는 Hold, Hold 한도(3건), 취소 사유 누락 |
| 401 | 본사·담당자 토큰 없음/위조/만료 |
| 403 | 다른 골프장 예약·티타임, 예약자 연락처 불일치, 다른 세션 Hold 해제 |
| 404 | 없는 티타임·예약 |
| 409 | 매진(`sold_out`), Hold 만료(`hold_expired`), 취소 기한 초과(`cancel_deadline_passed`), 수정 충돌, 이미 취소된 예약 |
| 429 | 로그인·예약 조회·취소 시도 과다 |

### 4.5 SSE 이벤트

`/api/events` 에 `hello`(stage 8), `catalog.changed`, `inventory.changed`, `reservations.changed`,
`tee-times.changed`, `partner-accounts.changed` 를 보냅니다. 예약 확정·취소 시
`reservations.changed` + `inventory.changed` 가 함께 나가 다른 기기 화면이 즉시 갱신됩니다.

---

## 5. 상태 전이

```
(예약 없음)
   │  Hold (TTL 5분)
   ▼
 active ──(확정)──▶ consumed ──▶ Reservation: confirmed
   │                                 │
   ├─(해제)──▶ released               ├─(고객/담당자/본사 취소)──▶ cancelled  (재고 복구, 환불 계산)
   └─(만료)──▶ expired  (재고 복구)   ├─(담당자)──▶ completed  (재고 유지)
                                       └─(담당자)──▶ no_show    (재고 유지)
```

- `cancelled` 는 다시 바꿀 수 없습니다(409 `already_cancelled`).
- 같은 예약을 다시 취소하면 `200 { alreadyCancelled:true }` 로 멱등 처리합니다.

---

## 6. 화면 연동

### 6.1 고객 앱 `/`

- 서버 연동(8단계) 모드: 티타임 잔여는 **서버 값** 그대로 표시하고, 상세 화면에
  "예약 재고가 서버와 실시간으로 공유됩니다" 안내를 띄웁니다.
- `예약` → 서버 Hold 생성(5분) → 결제 확인 모달(남은 시간 카운트다운) → `시연 결제 완료` →
  서버 확정 → 예약 완료 화면(서버 예약번호).
- `내 예약` → 서버 예약은 `source:'server'` 로 표시되고, 취소는 서버 API 로 처리됩니다
  (환불률·수수료·환불액은 서버 계산, 취소 후 잔여 팀 즉시 복구).
- 브라우저에서 예약한 연락처를 기억해, 새로고침·다른 기기에서도 그 연락처의 서버 예약을 다시 받아옵니다.
- 정적 시연 모드에서는 기존 로컬 예약 흐름을 그대로 사용합니다(네트워크 요청 0건).

### 6.2 골프장 콘솔 `/partner/`

- 메뉴 **예약 관리**: 선택일 서버 예약 목록(예약번호·예약자·연락처·인원·예약금·상태),
  확정/취소/확정 인원 통계, 상세 모달(특가·요금·지금 취소 시 환불액), 완료·노쇼·취소 처리.
- 취소 시 사유 입력(프롬프트) → 서버가 환불 계산·재고 복구 → 목록 갱신, 환불액 알림.
- **요금 설정**에 취소·환불 정책 입력(7일/4~6일/2~3일/1일/당일 환불률, 취소 가능 기한) 추가.
- 티타임 화면의 잔여 팀이 서버 예약·Hold 기준으로 표시됩니다.

### 6.3 본사 관리자 `/admin/`

- **전체 예약**: 전체 골프장 예약(상태·날짜 필터), 통계 KPI(전체/확정/취소/인원/활성 Hold),
  예약 상세 모달, 강제 취소(사유 필수)·완료·노쇼.
- **취소·환불**: 취소된 예약과 환불액을 서버 기준으로 표시.
- **승인 처리 이력**: `예약 확정`·`예약 취소`·`예약 상태 변경` 라벨로 예약 이력이 함께 표시됩니다.
- 정적 모드에서는 기존 localStorage 시연 화면으로 동작합니다(오류 없음).

---

## 7. 테스트 결과

실행:

```bash
npm test                            # 회귀 + 6단계 + 7단계 + 8단계
node tests/run-ui-smoke.js          # 화면 스크립트 스모크(partner/admin, 실제 서버)
```

| 구분 | 결과 |
|---|---|
| 기존 회귀(1~5단계) `tests/run-scenarios.js` | **120/120 통과** |
| 6단계 서버·DB `tests/run-server-scenarios.js` | **90/90 통과** |
| 7단계 계정·권한·운영 `tests/run-stage7-scenarios.js` | **187/187 통과** |
| 8단계 예약 엔진 `tests/run-stage8-scenarios.js` | **168/168 통과** |
| 화면 스크립트 스모크 `tests/run-ui-smoke.js` | **33/33 통과** |
| 합계 | **598개 검사 통과, 0 실패** |

전체 출력: `downloads/allgolf-stage8-evidence/test-results.txt`

### 7.1 8단계 테스트가 실제로 확인한 것

- health `stage:8`, 기능 플래그(`reservations·holds·inventoryLinked·idempotency·refunds`), DB 스키마 3, Hold TTL 공개
- 고객 앱 HTML 에 `data/server-reservations.js` 와 `v=20261125-stage8` 포함
- 골프장 A/B 승인·계정·티타임, 취소·환불 정책 저장(60/80/100%)과 환불률 120% 400
- 공개 카탈로그 `inventoryLinked:true`, 잔여 3·booked/held 0, 취소 정책 전달
- Hold 생성 201·만료시각, 같은 세션 재사용(200), 다른 세션 추가, 1팀 티타임 다른 세션 409,
  인원 초과 400, 세션 없는 요청 400, 세션당 3건 한도 400 `hold_limit`
- Hold 해제 후 잔여 +1 복구, 다른 세션 해제 403
- **Hold 만료(TTL 3초) 후 잔여 자동 복구**, 만료 Hold 로 확정 시 409 `hold_expired`,
  DB 에 `expired` 상태 기록
- 예약 확정 201, 번호 형식 `AG-YYMMDD-NNNNN`, 4인 그린피 150,000·총액 860,000·예약금 120,000,
  잔여 2, 응답에 `idempotencyHash`/`sessionId` 없음
- 인원 초과·휴대전화 형식·예약자 이름 누락 400, 다른 골프장 티타임 400, 없는 티타임 404
- **동시 3건 중 1건만 성공, 2건 409 `sold_out`**, 잔여 0
- **멱등 키 재전송 200 + 동일 예약번호, 잔여 4 유지(이중 차감 없음)**, 연락처 기준 목록 1건
- 예약 상세(본인 확인 시 전체 연락처), 1일 전 환불률 20%·환불 24,000, 다른 연락처 403, 없는 예약 404, 연락처 없이 400
- 취소 200·`demo_refunded`·수수료 96,000/환불 24,000, 재고 복구(3), 재취소 멱등, 다른 연락처 취소 403
- 2~3일 전 환불률 60%·환불 72,000, Hold 없이 즉석 예약 201
- 취소 가능 기한 48시간 설정 후 고객 취소 409 `cancel_deadline_passed`, 담당자 강제 취소 200(환불 60%)
- 담당자: A 목록 조회(전체 연락처)·통계, B 목록 0건(격리), courseId 위조 403, 타 골프장 상세·상태 변경 403,
  이용 완료·노쇼 전이, 완료 후 잔여 유지, 취소된 예약 상태 변경 409
- 대시보드 예약 `source:'server'`·`linked:true`·취소/환불 집계
- 본사: 전체 조회·필터·통계, 인증 401, 상세, 취소 사유 누락 400, 강제 취소 200(환불 100%),
  감사 로그 3종·고객 취소 로그(예약번호·환불 문구), 통계·운영 현황 예약 집계
- **SSE**: hello, 예약 생성 시 `inventory.changed`·`reservations.changed`·예약번호 수신
- DB v3, 예약·Hold 저장, 멱등 원문 미저장, `rsv:` 순번 보존
- 정적 모드: api-client 요청 0건, 예약 모듈 `linked:false`, 확정 시도 차단·요청 0건
- 서버 재시작 후 잔여·예약 목록·상세 유지, Hold 정상 동작
- v2 DB(예약 컬렉션 삭제) → v3 승격, 골프장·티타임·계정 유지, 예약 컬렉션 자동 생성
- 고객 앱 코드: 서버 티타임 2건, 잔여 서버 값 그대로(2), 마감 표시, 로컬 예약을 더해도 서버 잔여 유지
- **고객 앱 예약 플로우(화면 코드)**: Hold 요청 → 확정 요청(멱등 키·Hold id 포함) → 서버 예약이 `source:'server'` 로
  목록에 저장, 완료 화면에 예약번호, 기존 로컬 예약 유지, 연락처 기억

### 7.2 화면 스모크가 추가로 확인한 것

- partner: 서버 예약이 예약 관리 화면에 표시, 통계 표시, 취소 버튼 → 서버 상태 `cancelled` + 잔여 복구(2)
- admin: 전체 예약 화면에 예약 표시·통계, 예약 상세 모달, 감사 로그에 예약 확정·취소 라벨

### 7.3 7단계 테스트 중 기대값을 갱신한 4건 (검사 수 187 유지)

8단계에서 의도적으로 바뀐 동작이라 기대값만 고쳤습니다.

| 7단계 검사 | 이전 | 8단계 |
|---|---|---|
| 7단계 서버 표시 | `health.stage === 7` | `health.stage >= 7` (실제 8) |
| 재고 연동 여부 명시 | `inventoryLinked === false` + '8단계' 문구 | `inventoryLinked === true` + '서버' 문구 |
| DB 버전 | `version === 2` | `version === 3` (v1/v2 자동 호환) |
| 시연 예약 1건 후 잔여 | 로컬 차감으로 2 | 서버 재고 그대로 사용(중복 차감 없음)으로 2 |

또한 7단계 테스트의 앱 스텁에 `inventoryLinked() { return true; }` 를 추가해 8단계 서버를 흉내 내도록 했습니다.

### 7.4 검증하지 못한 범위 (솔직한 한계)

- **`127.0.0.1` 실브라우저 UI E2E 는 실행하지 못했습니다.** 이 환경의 원격 브라우저가 loopback 주소를 차단합니다.
  대신 (1) 실제 서버 API 통합 테스트, (2) 실제 화면 코드를 최소 DOM 에서 실행하는 스모크,
  (3) GitHub Pages 정적 모드 **실브라우저** 확인으로 구분해 검증했습니다.
- 서버 모드 화면(고객 앱 Hold 모달·파트너 예약 관리·본사 전체 예약)은 실제 브라우저의 CSS·레이아웃·모바일 뷰포트까지
  확인하지 못했습니다. 정적 모드 화면만 실브라우저에서 확인했습니다.
- 실제 다중 서버 프로세스·다중 머신 동시성은 검증하지 않았습니다(파일 DB 단일 프로세스 전제, 파일 잠금으로 같은 PC 다중 프로세스만 방어).
- 부하·대용량(예약 수만 건)에서의 성능은 측정하지 않았습니다. 매 변경마다 JSON 전체를 쓰는 구조입니다.
- 실제 PG 결제 승인·부분 환불·정산·알림(문자/푸시)·회원가입은 구현하지 않았습니다(범위 외).

---

## 8. 배포 결과

- PR #15 → `main` 머지 커밋 `210cc9c86748c7280549659a9e3279eefc5cb7de`
- GitHub Pages 빌드: `status: built` (해당 커밋 기준, `2026-11-25T02:26:47Z`, error 없음)

| URL | 상태 |
|---|---|
| https://neved12.github.io/all-golf-test/ | 200 |
| https://neved12.github.io/all-golf-test/partner/ | 200 |
| https://neved12.github.io/all-golf-test/admin/ | 200 |
| `data/server-reservations.js?v=20261125-stage8` | 200 |
| `data/server-catalog.js?v=20261125-stage8` | 200 |
| `app.js`, `partner/partner.js`, `admin/admin.js` (stage8) | 200 |

- 정적 자산 캐시 버전을 세 화면 모두 `?v=20261125-stage8` 로 갱신했습니다.
- 실브라우저 확인(정적 모드): 홈·골프장 상세 정상 렌더, 좌하단 `○ 정적 시연` 배지,
  **`/api/` 요청 0건, console error 0건**, 예약 모듈 `linked:false`.
  `/partner/` 운영 현황·`/admin/` 전체 예약 화면도 정상 렌더(배지 유지, `/api/` 0건).

증빙:

- `downloads/allgolf-stage8-evidence/01-pages-home-static-mode.png`
- `downloads/allgolf-stage8-evidence/02-pages-detail-static-mode.png`
- `downloads/allgolf-stage8-evidence/03-pages-partner-static-mode.png`
- `downloads/allgolf-stage8-evidence/04-pages-admin-reservations-static.png`
- `downloads/allgolf-stage8-evidence/test-results.txt` (598개 검사 전체 출력)
- `downloads/allgolf-stage8-evidence/pages-verification.txt` (Pages 빌드·HTTP·실브라우저 확인)

---

## 9. 집 Windows PC에서 실행하는 방법

```powershell
cd <저장소 폴더>
git pull
npm start
```

또는 `start-server.bat` 더블클릭. **`npm install` 은 필요 없습니다**(외부 패키지 0개). Node.js 18 이상.

| 화면 | 주소 |
|---|---|
| 사용자 앱 | http://127.0.0.1:4173/ |
| 골프장 관리자 | http://127.0.0.1:4173/partner/ |
| 본사 관리자 | http://127.0.0.1:4173/admin/ |
| API 상태 | http://127.0.0.1:4173/api/health |

### 9.1 처음 한 번

1. `/partner/` → **골프장 제휴 신청**으로 골프장 신청(또는 기존 골프장 선택)
2. `/admin/` → 기본 비밀번호 `allgolf-demo-2026` 로그인 → **제휴 신청 관리**에서 승인
3. **제휴 계정 관리** → 계정 생성(초기 비밀번호 1회 표시)
4. `/partner/` 로그인 → **티타임 관리**에서 티타임 등록(예약 가능 팀 1 이상)
5. 사용자 앱 `/` 에서 그 골프장·날짜를 열고 예약 → 예약 관리 화면에서 확인

빠른 시연:

```bash
npm run demo:partner-accounts      # 승인 골프장마다 계정 생성(콘솔 1회 출력)
```

### 9.2 환경변수(8단계 추가)

| 변수 | 설명 |
|---|---|
| `ALLGOLF_HOLD_TTL_SECONDS` | 임시확보 유지 시간(초, 기본 300) |
| `ALLGOLF_HOLD_SWEEP_SECONDS` | 만료 Hold 정리 주기(초, 기본 30) |
| `ALLGOLF_MAX_HOLDS` | 세션당 동시 Hold 수(기본 3) |

기존 변수(`ADMIN_PASSWORD`, `SESSION_SECRET`, `ALLGOLF_DB_PATH`, `PORT`, `HOST`, …)는 그대로입니다.

### 9.3 7단계 DB가 있는 경우

`git pull` 후 그대로 `npm start`. 서버가 기존 `db.json`(버전 2)을 읽어 예약·Hold 컬렉션을 추가하고
스키마 버전 3으로 저장합니다. 승인 골프장·계정·티타임·요금·특가는 그대로 유지됩니다.

### 9.4 시연 예약을 초기화하려면

```bash
# 서버를 끈 뒤
npm run db:reset-demo    # RESET 입력 → 예약·Hold 포함 전체 초기화(전 백업 자동)
```

---

## 10. 파일 DB의 한계와 9단계 준비 사항

### 10.1 한계(변경 없음)

- 단일 서버 프로세스 전제(파일 잠금으로 같은 PC 다중 프로세스만 방어). 여러 머신이 같은 파일을 공유하는 구성은 미지원.
- 매 변경마다 JSON 전체를 다시 쓰므로 대량 트래픽에 부적합. 감사 로그 10,000건·오래된 Hold 2일 보관.
- 로그아웃 폐기 목록은 메모리에 있습니다(서버 재시작 시 만료 전 토큰 재사용 가능 — 계정 상태·sessionEpoch 는 DB 로 유지).
- 쿠키 `SameSite=Lax` 로 CSRF 완화, 별도 CSRF 토큰 없음.
- 실제 결제·정산·알림·실골프장 연동 없음.

### 10.2 9단계 준비

1. **실제 결제(PG)**: 예약금 결제 승인·실패·부분 취소, `paymentStatus` 를 실제 상태로 교체.
2. **정산**: 예약·취소·환불을 골프장별 정산 주기로 집계, 수수료 계산.
3. **회원**: 예약자 연락처 기반 비회원 → 회원 전환, 본인 예약 목록 인증 강화(로그인 세션 기반).
4. **알림**: 예약 확정·취소·라운드 전날 알림(문자/푸시), 대기 알림과 연결.
5. **DB 이전**: 파일 DB → PostgreSQL/MySQL, `reservations`/`bookingHolds` 를 테이블·유니크 제약(티타임 중복 방지)으로 이전.
6. **노쇼·환불 정책 고도화**: 부분 환불, 취소 수수료 정산 차감, 골프장별 정책 UI 확장.

---

## 11. 변경 파일

```
server/lib/reservations.js        (신규) Hold·예약·취소/환불·재고 계산·멱등·번호 발급·응답 변환
server/lib/operations.js          재고(inventoryFor)·잔여 계산을 예약/Hold 기준으로, rates.cancellationPolicy, 카탈로그 inventoryLinked:true
server/lib/db.js                  스키마 v3, 예약·Hold 건수 상태, 복구 건수
server/lib/config.js              Hold TTL·정리 주기·세션당 한도 설정
server/routes/api.js              공개 Hold·예약·조회·취소, 담당자·본사 예약 API, SSE 알림, health stage 8
server/index.js                   만료 Hold 주기 정리, 예약 재고 로그
server/scripts/{backup,restore,reset-demo}.js  예약·Hold 건수 출력
server/data/db.seed.json          스키마 v3 시드
server/data/README.md             v3 스키마·재고 규칙·백업 안내
data/server-reservations.js       (신규) 서버 예약 클라이언트(Hold·확정·조회·취소·연락처 기억·로컬 목록 병합)
data/server-catalog.js            inventoryLinked 전달, inventory/reservations SSE 수신
data/api-client.js                요청 헤더 지원, health/stage/reservationLinked 노출, health 수신 알림
app.js                            서버 Hold→확정 예약 플로우, 서버 취소, 서버 재고 우선 표시, 안내 문구
index.html                        server-reservations 로드, 캐시 버전 stage8
partner/partner.js                예약 관리(서버 조회·상세·완료/노쇼/취소), 취소·환불 정책 설정, 잔여 표시
admin/admin.js                    전체 예약·상세·강제 취소, 취소·환불 화면, 감사 라벨
partner/index.html, admin/index.html  캐시 버전 stage8
styles.css                        서버 재고 연동 안내 스타일
README.md, .env.example, package.json, tests/README.md   8단계 설명·환경변수·테스트 스크립트·버전 8.0.0
tests/run-stage8-scenarios.js     (신규) 8단계 168개
tests/run-ui-smoke.js             예약 관리·취소·전체 예약 스모크 추가(33개)
tests/run-stage7-scenarios.js     8단계 동작에 맞춘 기대값 4건 갱신(검사 수 동일)
ALLGOLF_8단계_완료보고서.md        이 문서
```

---

## 12. 결론

8단계 요구 사항(서버 예약·원자적 재고 잠금·동시 예약 방어·멱등 키·예약 조회/취소/환불·담당자/본사 연동·
정적 폴백·DB v3)을 구현하고, 기존 397건과 신규 168건 + 화면 스모크 33건, 총 **598개 검사**를 통과했습니다.
PR #15 로 `main` 에 병합했고 GitHub Pages 빌드·HTTP 200·정적 모드 실브라우저(요청 0건·오류 0건)를 확인했습니다.

남은 핵심 한계는 **실제 결제·정산·알림과 파일 DB의 단일 프로세스 전제**이며, 이는 9단계 이후 과제입니다.

# ALL:GOLF 9단계 완료 보고서 — 본사 운영 자동화(운영 통계·제휴 성과·수수료/정산 시뮬레이션·알림 로그)

- 작성일: 2026-11-26 (KST)
- 저장소: `neved12/all-golf-test`
- 배포: <https://neved12.github.io/all-golf-test/>
- 9단계 코드 PR: [#17](https://github.com/neved12/all-golf-test/pull/17) → `main` 병합 커밋 `047e48e`
- 배포 확인: GitHub Pages 빌드 `built` (커밋 `047e48e`, 2026-11-26 04:54:46Z), `/`, `/admin/`, `/partner/`, 정적 자산 모두 HTTP 200
- 통합검증 중 발견한 모바일 360px 찜 목록 가로 넘침 수정
  - 1차 `005e414` (04:54 이후 배포) → 재측정에서 미해결 확인
  - 2차 `7aacb4f` (05:06:42Z 배포) → 재측정에서 **전 화면 통과 확인**
- 버전: `package.json` `9.0.0`, 정적 자산 캐시 `?v=20261126-stage9` (9단계 최초 배포) → 수정 재배포 시 `?v=20261126-stage9b`, DB 스키마 **v4**

---

## 1. 요약

9단계의 목표는 "본사가 서비스 전체를 숫자로 보고, 골프장별 수수료와 정산을 시뮬레이션하며, 운영 알림이 어떻게 나가는지 확인할 수 있게" 하는 것입니다. 실제 결제·이체·문자 발송은 하지 않고, **서버 파일 DB 안에서 계산·기록만 하는 시연용 운영 자동화**로 구현했습니다.

| 요구 | 구현 | 검증 |
|---|---|---|
| 기간별·골프장별 예약 건수·GMV·취소/환불·노쇼율·1·2·3부 분포 | `/api/admin/analytics` + `/admin/` 운영 통계 화면 | 9단계 테스트 200건 중 통계 30여 항목, 정확값 일치 |
| 제휴 신청 → 승인 전환율 | 같은 API의 `applications` 블록(신청·승인·반려·전환율) | 승인 2/신청 2 → 100% 확인 |
| CSV/JSON 내보내기 | `?format=csv`(UTF-8 BOM, Content-Disposition), 화면 JSON 다운로드 | BOM 바이트(EF BB BF)·행 수·파일명 확인 |
| 골프장별 수수료율(기본 8%, 0~30%) | `GET/PUT /api/admin/commissions[/:courseId]` | 범위 초과 400, 이전 버전 409, 감사 로그 |
| 확정/완료 예약 + 취소 수수료 반영 정산액 | 정산 엔진 `server/lib/analytics.js` | 6건 예약·취소 1건으로 손계산 금액과 일치 |
| 정산서 DRAFT/PENDING → CONFIRMED → PAID | `/api/admin/settlements/:id/transition` | 전이 3단계 200, 건너뛰기/역행/중복 409 |
| 동일 기간 중복 정산 409 | `createSettlement()` 중복·겹침 검사 | `duplicate_settlement`/`overlapping_settlement` 409 |
| 파트너 본인 골프장 정산·수수료만 조회, 타 골프장 403 | `/api/partner/settlements`, `/api/partner/commission` | 목록·상세·쿼리 403, 생성·전이 403 |
| 예약 확정·취소·정산 확정 시 시연 알림 로그 | `notificationLogs` + `/api/admin|partner/notifications` | 16건 기록·상태 `simulated`·연락처 마스킹 |
| DB v4 자동 승격·재시작 유지 | `db.js` `SCHEMA_VERSION = 4` | v3 DB 승격, 재시작 후 정산/수수료/알림 유지 |
| 정적 모드 요청 0건 유지 | 화면 분기 + `apiClient` 정적 모드 | DOM 스모크에서 fetch 0건 확인 |

**테스트 결과: 총 820건 전부 통과** (기존 598 + 9단계 200 + 화면 스모크 22 추가)

---

## 2. 구현 방식과 설계 판단

### 2.1 통계는 "예약 접수일", 정산은 "라운드일" — 두 기준을 분리한 이유

- **운영 통계**: 기간(오늘/7일/30일/전체)을 `reservation.createdAt`(예약 접수일) 기준으로 집계합니다.
  골프 예약은 미래 라운드 예약이 대부분이라, 라운드일 기준으로 "오늘"을 잡으면 대시보드가 항상 0에 가깝게 보입니다.
  본사가 알고 싶은 "오늘 예약이 몇 건 들어왔고 얼마인가"에 맞춘 선택입니다.
- **정산서**: 정산 대상 기간에 **라운드일(`reservation.date`)** 이 포함된 예약을 계산합니다. 정산은 "그 기간에 실제로 라운드한 건"을 정산하는 것이므로 접수일이 아니라 라운드일이 맞습니다.

두 기준이 다르다는 사실은 API `basis` 필드, 화면 안내 문구, 보고서에 모두 명시했습니다.

### 2.2 금액 정의(감사 가능한 계산식)

```
GMV            = 취소되지 않은 예약(확정·이용완료·노쇼)의 예약 총액(totalEstimated) 합
취소 수수료     = 취소 예약의 (예약금 − 환불액), 즉 환불 후 골프장에 남는 수익
정산 기준액     = GMV + 취소 수수료
플랫폼 수수료   = round(정산 기준액 × 골프장별 수수료율)
정산 예정액     = 정산 기준액 − 플랫폼 수수료
```

- 노쇼는 "예약이 성립해 골프장 자리를 차지한 건"으로 보아 GMV에 포함하고, 노쇼율로 따로 보여 줍니다.
- 환불액은 GMV에서 빼지 않고 별도 지표로 노출합니다(예약금 기준으로 이미 계산된 값이므로 이중 차감을 피함).
- 계산식은 정산서 `calculation.formula`에 문자열로 남겨, 나중에 화면·보고서에서 그대로 확인할 수 있게 했습니다.

### 2.3 수수료율은 "정산서에 스냅샷"

- 기본 8%, 0~30% 범위. 관리자만 설정할 수 있고 `version` 기반 낙관적 잠금(이전 버전 409)과 감사 로그(`commission.updated`)를 남깁니다.
- 정산서를 만들 때 그 시점 수수료율을 정산서에 복사합니다. 이후 수수료율을 바꿔도 **이미 만든 정산서 금액은 변하지 않습니다**(테스트로 확인: 10%로 만든 정산서는 율을 12%로 올린 뒤에도 10%·347,600원 유지).

### 2.4 정산 상태 전이는 한 방향만

```
DRAFT(작성 중) → PENDING(확인 대기) → CONFIRMED(확정) → PAID(지급 완료)
```

- 건너뛰기(DRAFT→PAID), 역행(PAID→CONFIRMED), 같은 상태 재전이는 모두 `409 invalid_transition`.
- 모든 전이는 `history`(상태·시각·처리자·메모)와 감사 로그(`settlement.created`, `settlement.pending`, `settlement.confirmed`, `settlement.paid`)에 남습니다.
- 확정·지급 시 파트너 대상 정산 알림(시연)이 자동 기록됩니다.

### 2.5 중복 정산 방어는 "같은 기간"보다 조금 더 엄격하게

- 같은 골프장·같은 기간 → `409 duplicate_settlement`
- 기간이 일부라도 겹치면 → `409 overlapping_settlement`

요구사항은 "동일 기간 중복 방어"였지만, 기간이 겹치면 같은 라운드가 두 정산서에 두 번 계산될 수 있어 겹침까지 막았습니다. 월 단위 정산처럼 겹치지 않는 운영에는 영향이 없습니다.

### 2.6 권한: 본사는 전체, 파트너는 자기 골프장만

- 파트너 API는 세션의 `courseId`로만 대상을 정합니다. 쿼리로 다른 골프장 ID를 넘기면 `403`.
- 다른 골프장 정산서 ID를 직접 조회해도 `403`.
- 파트너는 정산서 **생성·상태 변경 불가**(`403 forbidden_role`). 조회 전용입니다.

### 2.7 알림은 "시뮬레이션"임을 구조적으로 명시

- `notificationLogs` 항목은 항상 `status: "simulated"`, `simulated: true`, `externalSend: false`입니다.
- 수신 대상은 고객(예약자, 연락처 마스킹 `010-****-5678`)과 골프장 담당자로 나누고, 채널은 `simulated_sms`, `simulated_push`, `simulated_settlement`만 존재합니다.
- API 응답·화면·DB 문서 모두 "실제 문자·푸시·PG 이체 아님"을 문구로 남깁니다.

### 2.8 정적 모드(GitHub Pages) 보존

- 9단계 화면은 `apiClient.isServer()`일 때만 서버 데이터를 요청합니다.
- 서버가 없으면 운영 통계는 "정적 시연 모드에서는 서버 운영 통계가 없습니다", 정산 화면은 기존 예시 표 + 안내를 보여 주고 **네트워크 요청을 보내지 않습니다**.
- DOM 스모크에서 서버 없이 admin 화면을 띄워 analytics/settlements 페이지를 눌러도 fetch 0건임을 확인했습니다.

---

## 3. DB 구조 (스키마 버전 4)

기존 v1·v2·v3 `db.json`은 읽을 때 빠진 컬렉션을 채워 **v4로 자동 승격**합니다(데이터 이전 불필요).

```json
{
  "version": 4,
  "commissionRates": {
    "<courseId>": { "courseId": "", "ratePercent": 10, "version": 2,
                    "updatedAt": "", "updatedBy": { "type": "admin", "email": "" } }
  },
  "settlements": [
    { "id": "stl-...", "number": "ST-YYYYMM-NNNN", "courseId": "", "courseName": "",
      "period": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
      "status": "DRAFT|PENDING|CONFIRMED|PAID",
      "commissionRatePercent": 10,
      "grossAmount": 3380000, "cancellationFee": 96000, "refundAmount": 24000,
      "basisAmount": 3476000, "platformFee": 347600, "payoutAmount": 3128400,
      "calculation": { "...": "계산 상세·수식" },
      "history": [ { "status": "DRAFT", "at": "", "by": {}, "note": "" } ],
      "version": 4, "createdAt": "", "updatedAt": "", "confirmedAt": null, "paidAt": null }
  ],
  "notificationLogs": [
    { "id": "NT-...", "at": "", "event": "reservation.confirmed|reservation.cancelled|settlement.confirmed|settlement.paid",
      "channel": "simulated_sms|simulated_push|simulated_settlement",
      "recipient": { "type": "customer|partner", "name": "", "phone": "010-****-5678", "courseId": "" },
      "subject": "", "summary": "", "status": "simulated", "simulated": true, "externalSend": false }
  ]
}
```

- `meta.sequences`에 `stl:YYYYMM` 정산번호 순번이 남습니다.
- `server/data/db.seed.json`도 v4로 갱신했습니다.

---

## 4. API 목록 (9단계 추가분)

### 4.1 본사 관리자 (모두 세션 인증 필요, 미인증 401)

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/admin/analytics?period=today\|7d\|30d\|all&courseId=&format=json\|csv` | 운영 통계·제휴 성과. CSV는 `text/csv; charset=utf-8`, UTF-8 BOM |
| GET | `/api/admin/commissions` | 승인 골프장별 수수료율(기본 8%, 0~30%, 미완료 정산 수) |
| PUT | `/api/admin/commissions/:courseId` | 수수료율 변경 `{ ratePercent, version }` |
| GET | `/api/admin/settlements?status=&courseId=&from=&to=` | 정산서 목록·상태별 집계·합계 |
| POST | `/api/admin/settlements` | 정산서 생성 `{ courseId, from, to, status?: DRAFT\|PENDING }` |
| GET | `/api/admin/settlements/export` | 정산서 CSV |
| GET | `/api/admin/settlements/:id` | 정산서 상세(ID 또는 정산번호) |
| POST | `/api/admin/settlements/:id/transition` | 상태 전이 `{ status, version?, note? }` |
| GET | `/api/admin/notifications?courseId=&event=&limit=` | 시연 알림 로그 |

### 4.2 골프장 담당자

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/partner/settlements` | 본인 골프장 정산 내역·수수료율·합계(조회 전용) |
| GET | `/api/partner/settlements/:id` | 본인 골프장 정산서 상세(타 골프장 403) |
| GET | `/api/partner/commission` | 본인 수수료율 |
| GET | `/api/partner/notifications` | 본인 골프장 알림 로그만 |
| POST | `/api/partner/settlements`, `/api/partner/settlements/:id/transition` | 403 (`forbidden_role`) — 본사만 가능 |

### 4.3 상태 코드

| 코드 | 상황 |
|---|---|
| 400 | 잘못된 기간(역순·누락), 수수료율 범위(0~30) 위반, 숫자 아님 |
| 401 | 관리자/담당자 미인증 |
| 403 | 타 골프장 접근, 담당자의 정산 생성·전이 |
| 404 | 없는 골프장·정산서 |
| 409 | `duplicate_settlement`, `overlapping_settlement`, `invalid_transition`, `version_conflict` |

### 4.4 health 응답

- `stage: 9`, `stages: [1..9]`, `db.schemaVersion: 4`
- `features`: `analytics`, `settlements`, `commissions`, `notifications` = true
- `settlement`: `statuses`, `defaultCommissionPercent: 8`, `commissionRange: [0, 30]`

---

## 5. 상태 전이

```
정산서
  DRAFT ──▶ PENDING ──▶ CONFIRMED ──▶ PAID
    │           │            │
    └───────────┴────────────┴── (그 외 전이는 409)

전이 시 기록
  · history[]: status, at, by(관리자), note
  · auditLogs: settlement.created / settlement.pending / settlement.confirmed / settlement.paid
  · CONFIRMED·PAID: notificationLogs (정산 확정·지급 알림, 시연)
```

예약 상태(8단계 유지)와 별개로 동작하며, 정산은 예약을 변경하지 않습니다.

---

## 6. 화면 연동

### 6.1 본사 관리자 `/admin/`

- **운영 통계·제휴 성과** (신규 메뉴)
  - 기간 탭: 오늘 / 최근 7일 / 최근 30일 / 전체
  - KPI: 예약 건수, GMV, 취소·환불액, 취소 수수료, 노쇼율, 객단가
  - 제휴 성과: 신청·승인·반려·승인 전환율·기간 내 승인
  - 1·2·3부 분포 표, 골프장별 표(예약·인원·GMV·환불·수수료·정산 기준액·수수료율·플랫폼 수수료·정산 예정액)
  - CSV / JSON 내보내기 버튼
- **정산·수수료 관리** (기존 '정산 관리' 메뉴를 서버 모드에서 확장)
  - 정산서 생성 폼(골프장·시작일·종료일·DRAFT/PENDING), 계산 결과 안내
  - 정산서 목록: 상태 배지, 다음 처리 버튼(확인 대기/확정/지급 완료), 버전 전달
  - 골프장별 수수료율 표: 현재 율·입력·저장·최근 변경·미완료 정산
  - 정산 CSV 내보내기
  - 정적 모드에서는 기존 예시 표 + 안내 문구(요청 0건)

### 6.2 골프장 담당자 `/partner/`

- **정산 내역**(신규): 본인 수수료율, 정산 기준액·플랫폼 수수료·정산 예정액·지급 완료 합계, 정산서 목록(상태·율·예약·GMV·취소 수수료)
- **알림 로그**(신규): 시각·이벤트·채널·수신 대상·제목·요약·상태(시연 발송 기록)
- 운영 현황 대시보드에 수수료율 카드와 '정산 내역' 바로가기 추가
- 정산·알림은 **조회 전용**임을 화면에 명시

---

## 7. 테스트 결과

### 7.1 전체 (2026-11-26 실행)

| 구분 | 명령 | 결과 |
|---|---|---|
| 기존 회귀 | `node tests/run-scenarios.js` | **120/120** |
| 6단계 서버·DB | `node tests/run-server-scenarios.js` | **90/90** |
| 7단계 계정·권한 | `node tests/run-stage7-scenarios.js` | **187/187** |
| 8단계 예약 엔진 | `node tests/run-stage8-scenarios.js` | **168/168** |
| **9단계 신규** | `node tests/run-stage9-scenarios.js` | **200/200** |
| 화면 스모크 (기존 33 + 9단계 22) | `node tests/run-ui-smoke.js` | **55/55** |
| **합계** | | **820/820** |

`npm test`는 1~9단계 서버 테스트를 모두 실행합니다.

### 7.2 9단계 테스트가 실제로 확인한 것 (200건)

- 서버 기동: `stage 9`, `stages[1..9]`, 스키마 4, 기능 플래그, 수수료 기본값/범위, 정산 상태 4단계, 캐시 버전
- 수수료율: 기본 8%, 10% 설정, 31%·−1%·'abc' 400, 이전 버전 409, 없는 골프장 404, 미인증 401, 담당자 본인 조회, 타 골프장 403, 감사 로그
- 예약 데이터: 4인 860,000원 / 3인 800,000원 / 다른 골프장 900,000원, 고객 취소(1일 전 20% → 환불 24,000·수수료 96,000), 이용 완료, 노쇼
- 통계(오늘): 예약 6건, 확정 3·이용완료 1·노쇼 1·취소 1, GMV 4,280,000, 인원 19, 환불 24,000, 취소 수수료 96,000, 기준액 4,376,000, 노쇼율 20%, 취소율 16.7%, 객단가 856,000, 1부 3·2부 1·3부 1
- 골프장별: A GMV 3,380,000·수수료율 10%·플랫폼 수수료 347,600·정산 예정 3,128,400 / B GMV 900,000·8%·72,000
- 제휴 성과: 신청 2·승인 2·전환율 100%
- 기간 필터: 7일/30일 동일, 전체 from=null, 골프장 필터, 미인증 401, **45일 전 접수로 바꾼 예약이 오늘/30일에서 빠지고 전체에는 남음**
- CSV: 200, `text/csv`, `Content-Disposition`, BOM 바이트, 헤더, 행 수(헤더+2곳+합계), 골프장명, 수수료율, 미인증 401
- 정산서: ST-YYYYMM-NNNN, DRAFT, 율 스냅샷 10%, GMV 3,380,000, 취소 수수료 96,000, 기준액 3,476,000, 수수료 347,600, 예정 3,128,400, 예약 5·취소 1, 계산식
- 중복: 같은 기간 409 `duplicate_settlement`, 겹치는 기간 409 `overlapping_settlement`, 역순 400, 기간 누락 400, 없는 골프장 404, 미인증 401
- 전이: DRAFT→PAID 409, DRAFT→PENDING 200, 같은 상태 409, 이전 버전 409, PENDING→CONFIRMED 200(확정 시각), CONFIRMED→PAID 200(지급 시각), PAID→CONFIRMED 409, 이력 4단계·처리자
- 감사 로그: 생성·확정·지급, 목록 2건·상태 집계·합계·상태 필터, 정산 CSV, 정산번호로 상세 조회
- 수수료율 변경: 12% 변경 후 기존 정산서 10%·금액 불변, 새 기간 정산서 12%, 통계는 현재 율(417,120) 반영
- 파트너: A 정산 2건·B 없음·12%·합계, B courseId 403, B 정산서 상세 403, 본인 상세 200, 생성 403, 전이 403, B 1건, 미인증 401
- 알림: 16건(예약 6×2 + 취소 2 + 정산 2), 4종 이벤트, 전부 `simulated`·`externalSend:false`, 수신 대상·채널·제목·요약·시각, 실제 발송 아님 안내, 마스킹, 정산 예정액 문구, 이벤트 필터 1건, 골프장 필터 B 2건, A 14건·B 2건, B가 A 403, 미인증 401
- DB v4: 버전 4, 수수료율·정산 3건·알림 16건 저장, 정산 순번, 멱등 키 원문 없음
- 재시작: 스키마 4, 정산 3건, PAID·금액 유지, 수수료율 12%, 알림 16건, 담당자 정산 2건
- v3 승격: v3 DB → v4, 골프장·예약 유지, 새 컬렉션 0/0/0, 통계 조회, 기본 8%, 정산 생성 가능
- 정적 모드: 즉시 정적, API 요청 0건

### 7.3 화면 스모크가 추가로 확인한 것 (9단계 22건)

- 파트너(실서버): 정산 내역 화면·정산번호·상태·조회 전용 안내, 알림 로그 화면·예약 확정 기록·시연 발송 기록
- 본사(실서버): 운영 통계 화면·GMV/노쇼율·골프장/수수료율·승인 전환율·기간 전환, 정산 화면·기존 정산서·수수료율 입력·**화면에서 9% 저장 → 서버 반영**·**화면에서 정산서 생성 → 서버 반영**·**화면에서 DRAFT→PENDING 전이 → 서버 반영**
- 정적 모드: 서버 없이 admin 화면 → 운영 통계/정산 페이지 안내 문구, **fetch 0건**

### 7.4 기존 테스트 기대값 6건 조정 (검사 수는 유지)

9단계는 서버 단계·DB 스키마·캐시 버전을 올리므로, 이전 단계 테스트의 고정 기대값이 충돌합니다. 8단계 때 7단계 테스트를 조정한 것과 같은 방식으로, **검사 항목 수는 그대로 두고 조건만 "이상"으로** 바꿨습니다.

| 파일 | 기존 | 변경 |
|---|---|---|
| run-stage7 | `rawDb.version === 3` | `>= 3` (9단계 v4 호환) |
| run-stage8 | `health.stage === 8` | `>= 8` |
| run-stage8 | `health.db.schemaVersion === 3` | `>= 3` |
| run-stage8 | 캐시 `v=20261125-stage8` | `v=20261126-stage9` |
| run-stage8 | `rawDb.version === 3` | `>= 3` |
| run-stage8 | v2→v3 승격 `=== 3` | `>= 3` (실제 v4) |

### 7.5 검증하지 못한 범위 (솔직한 한계)

- **서버 모드 UI의 실제 브라우저 렌더링**: 원격 브라우저에서 `127.0.0.1` 접속이 막혀 있어, 서버 모드 화면은 ①HTTP API 통합 테스트 ②최소 DOM에서 실제 화면 스크립트를 실행해 클릭 핸들러까지 호출하는 스모크로 검증했습니다. CSS·픽셀 렌더링은 이 경로로 검증되지 않았습니다.
- **실브라우저 검증은 GitHub Pages(정적 모드)에서만** 했습니다. 서버 모드 전용 화면(정산·수수료·통계 데이터 표)은 정적 모드에서 안내 문구로 대체되므로, 실제 브라우저에서는 "정적 폴백이 정상 동작"까지만 확인됩니다.
- 실제 PG 결제·은행 이체·SMS/푸시 발송은 구현하지 않았으므로 검증 대상이 아닙니다(시뮬레이션).

---

## 8. 배포 결과

| 항목 | 결과 |
|---|---|
| PR | [#17](https://github.com/neved12/all-golf-test/pull/17) 생성 → `main` 병합 |
| 병합 커밋 | `047e48e` (9단계 기능), `005e414`·`7aacb4f` (360px 넘침 수정) |
| Pages 빌드 | `status: built` (047e48e: 04:54:46Z, 005e414: 05:02:32Z, 7aacb4f: 05:06:42Z) |
| HTTP 확인 | `/` 200, `/admin/` 200, `/partner/` 200, `/admin/admin.js` 200, `/data/api-client.js` 200 |
| 캐시 버전 | 최초 배포 `?v=20261126-stage9`, 수정 배포 `?v=20261126-stage9b` 확인 |
| 런타임 오류 | admin 운영 통계·정산 화면 이동/조작 중 `window.onerror`·`unhandledrejection` 0건, 실패 리소스 0건 |
| 브라우저 확인 | ① admin 운영 통계(정적 폴백) ② admin 정산·수수료(정적 폴백) ③ 고객 앱 홈·검색·상세·예약 완료·내 예약·대기 ④ admin 제휴 신청·백업 ⑤ partner 제휴 신청 |

증빙 스크린샷: `downloads/allgolf-stage9-evidence/` (12장) — 목록은 9장 참고.

---

## 9. 증빙 파일

`downloads/allgolf-stage9-evidence/`

| 파일 | 내용 |
|---|---|
| `01-admin-analytics-static.png` | 배포 사이트 `/admin/` 운영 통계·제휴 성과(정적 폴백 안내) |
| `02-admin-settlements-static.png` | 배포 사이트 `/admin/` 정산·수수료 관리(정적 폴백 + 예시 표) |
| `03-app-home.png` | 고객 앱 홈(재방문·최근 검색·찜) |
| `04-app-search-list.png` | 검색 결과 245곳·3/4인 가격·티타임·찜 |
| `05-app-course-detail.png` | 상세(1·2·3부, 티타임, 이용요금·3인 추가금, 공유/찜) |
| `06-app-booking-complete.png` | 예약 완료(예약번호·예약금·현장결제·.ics) |
| `07-app-my-bookings.png` | 내 예약(다가오는/지난) |
| `08-app-booking-detail.png` | 예약 상세(요금 내역·취소·환불 예상) |
| `09-app-waitlist.png` | 빈자리 알림 등록 결과 |
| `10-admin-applications.png` | 제휴 신청 관리(승인 완료 2건) |
| `11-admin-backup-restore.png` | 시연 데이터 백업·복원(개인정보 제외 안내) |
| `12-partner-apply.png` | 골프장 제휴 신청 화면 |
| `13-responsive-360-390-430.png` | 360/390/430 반응형 점검 결과(수정 후, 전 조합 통과) |

부가: `downloads/ALLGOLF-AG-261126-17219.ics` — 예약 완료 화면에서 내려받은 일정 파일(정적 시연 예약 1건).

---

## 10. 집 Windows PC에서 실행하는 방법

```bash
git pull
npm start            # = node server/index.js  (npm install 불필요)
```

- 사용자 앱 <http://127.0.0.1:4173/>
- 골프장 관리자 <http://127.0.0.1:4173/partner/>
- 본사 관리자 <http://127.0.0.1:4173/admin/>
- 9단계 확인 위치
  - 본사: **운영 통계·제휴 성과**, **정산·수수료 관리**
  - 골프장: **정산 내역**, **알림 로그**
- 시연 순서 예시
  1. partner에서 골프장 승인·계정 발급 → 담당자 로그인 → 티타임·요금 등록
  2. 앱에서 예약 1~2건 → admin 예약에서 취소/이용완료/노쇼 처리
  3. admin **운영 통계**에서 GMV·노쇼율 확인 → **정산·수수료**에서 수수료율 10% 저장
  4. 정산서 생성(기간 선택) → 확인 대기 → 확정 → 지급 완료
  5. partner **정산 내역**·**알림 로그**에서 같은 내용 확인

기존 v1~v3 `db.json`이 있어도 그대로 v4로 승격됩니다. 초기화는 서버를 끄고 `npm run db:reset-demo`.

---

## 11. 변경 파일

- 신규: `server/lib/analytics.js`, `tests/run-stage9-scenarios.js`
- 서버: `server/routes/api.js`(9단계 API·알림 기록·health), `server/lib/db.js`(v4), `server/lib/operations.js`(todayKst 인자), `server/index.js`(배너), `server/data/db.seed.json`, `server/data/README.md`
- 화면: `admin/admin.js`(통계·정산·수수료 페이지), `partner/partner.js`(정산·알림), `styles.css`(360px 넘침 수정 2회), `index.html`·`admin/index.html`·`partner/index.html`(캐시 버전 stage9 → stage9b)
- 문서·설정: `README.md`, `tests/README.md`, `package.json`(9.0.0, test:stage9)
- 테스트 조정: `tests/run-stage7-scenarios.js`, `tests/run-stage8-scenarios.js`, `tests/run-ui-smoke.js`(+22건)

---

## 12. 결론

9단계에서 본사는 예약·제휴·취소·환불을 기간·골프장 단위로 숫자로 보고, 골프장별 수수료율을 정하고, 정산서를 만들어 확정·지급까지 상태를 진행할 수 있게 되었습니다. 모든 계산은 서버 파일 DB 안에서 감사 가능한 수식으로 이루어지고, 파트너는 자기 골프장의 정산·알림만 볼 수 있으며, 실제 결제·이체·문자 발송은 없다는 점이 API·화면·DB·문서에 일관되게 표시됩니다.

기존 1~8단계 테스트 565건과 화면 스모크 33건은 그대로 통과했고, 9단계 신규 200건과 화면 스모크 22건을 더해 **총 820건 전부 통과**했습니다. GitHub Pages 정적 배포도 `built`·HTTP 200·런타임 오류 0건으로 확인했습니다.

다음 단계(10단계 투자자 데모 패키지)는 이번 범위에서 제외했습니다.

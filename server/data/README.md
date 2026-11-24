# 서버 데이터 폴더

ALL:GOLF 7단계 서버의 **파일 기반 DB**가 이 폴더를 사용합니다.

| 경로 | 설명 | Git 포함 |
|---|---|---|
| `db.json` | 실제 실행 중인 데이터(제휴 신청·승인, 담당자 계정, 티타임, 요금, 특가, 감사 로그) | ✗ (`.gitignore`) |
| `db.seed.json` | 빈 DB 시드(스키마 버전 2). `db.json` 이 없을 때 이 내용으로 새로 만듭니다. | ✓ |
| `backups/db-YYYY-MM-DD.json` | 하루에 한 번 자동으로 남기는 스냅샷 | ✗ |
| `db.json.lock` | 여러 프로세스가 동시에 쓰지 못하게 하는 잠금 파일 | ✗ |

## 스키마(버전 2)

```json
{
  "version": 2,
  "meta": { "createdAt": "", "updatedAt": "", "revision": 0, "sequences": {}, "lastBackupDate": "" },
  "applications": [],
  "approvedCourses": [],
  "partnerAccounts": [
    { "id": "PN-YYMMDD-NNNN", "courseId": "", "email": "", "name": "", "role": "owner|manager|viewer",
      "status": "active|disabled", "passwordHash": "scrypt", "passwordSalt": "", "sessionEpoch": 1,
      "version": 1, "createdAt": "", "updatedAt": "", "lastLoginAt": null }
  ],
  "teeTimes": [
    { "id": "tt-...", "courseId": "", "course": "전체", "date": "YYYY-MM-DD", "time": "HH:MM",
      "session": "1부|2부|3부", "capacityTeams": 1, "maxPlayers": 4, "greenFee": 150000,
      "status": "open|stopped|closed", "version": 1, "createdAt": "", "updatedAt": "" }
  ],
  "rates": { "<courseId>": { "baseGreenFee": 150000, "threePlayerGreenFee": null, "fourPlayerGreenFee": null,
    "threePlayerSurcharge": 10000, "twoPlayerSurcharge": 0, "depositType": "person", "depositValue": 30000, "version": 1 } },
  "specialOffers": [],
  "reservations": [],
  "bookingHolds": [],
  "auditLogs": []
}
```

- 기존 6단계 `db.json`(버전 1)은 서버가 읽을 때 빈 7단계 컬렉션을 보완해 그대로 사용합니다.
- `passwordHash`/`passwordSalt` 는 Node 내장 `crypto.scryptSync` 결과이며 평문 비밀번호는 저장하지 않습니다.
- `sessionEpoch` 는 계정 상태·권한 변경 시 올라가고, 기존 세션 토큰의 epoch 와 다르면 서버가 401로 거부합니다.
- `reservations`/`bookingHolds` 는 8단계(예약 서버 이전)용 자리이며 7단계에서는 API로 생성하지 않습니다.
  (테스트에서 삭제 차단 조건을 검증할 때만 파일에 직접 넣습니다.)

## 백업

- 서버가 그날 처음 DB를 수정할 때 `backups/db-YYYY-MM-DD.json` 을 자동으로 만듭니다.
- 수동 백업: `npm run db:backup` → `backups/db-YYYY-MM-DD-HHMMSS-manual.json`
- 파일 복사만으로도 백업이 됩니다. `db.json` 한 파일이 전체 데이터입니다.

## 복구

1. 서버를 종료합니다.
2. `npm run db:restore -- backups/db-2026-11-24.json` (또는 파일을 `db.json` 으로 복사)
3. 서버를 다시 시작합니다.

복구 전 데이터는 `backups/db-before-restore-*.json` 으로 자동 보존됩니다.

## 초기화(시연용)

`npm run db:reset-demo` → 확인 문구를 입력하면 DB를 빈 시드 상태로 되돌립니다.
이 명령은 **제휴 신청·승인·담당자 계정·티타임·특가**를 모두 지우므로 실제 데이터가 있는 곳에서는 쓰지 마세요.

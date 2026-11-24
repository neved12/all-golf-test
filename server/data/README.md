# 서버 데이터 폴더

ALL:GOLF 6단계 서버의 **파일 기반 DB**가 이 폴더를 사용합니다.

| 경로 | 설명 | Git 포함 |
|---|---|---|
| `db.json` | 실제 실행 중인 데이터(제휴 신청·승인 이력·승인 골프장) | ✗ (`.gitignore`) |
| `db.seed.json` | 빈 DB 시드. `db.json` 이 없을 때 이 내용으로 새로 만듭니다. | ✓ |
| `backups/db-YYYY-MM-DD.json` | 하루에 한 번 자동으로 남기는 스냅샷 | ✗ |
| `db.json.lock` | 여러 프로세스가 동시에 쓰지 못하게 하는 잠금 파일 | ✗ |

## 백업

- 서버가 그날 처음 DB를 수정할 때 `backups/db-YYYY-MM-DD.json` 을 자동으로 만듭니다.
- 수동 백업: `npm run db:backup` → `backups/db-YYYY-MM-DD-HHMMSS.json`
- 파일 복사만으로도 백업이 됩니다. `db.json` 한 파일이 전체 데이터입니다.

## 복구

1. 서버를 종료합니다.
2. `npm run db:restore -- backups/db-2026-11-24.json` (또는 파일을 `db.json` 으로 복사)
3. 서버를 다시 시작합니다.

복구 전 데이터는 `backups/db-before-restore-*.json` 으로 자동 보존됩니다.

## 초기화(시연용)

`npm run db:reset-demo` → 확인 문구를 입력하면 DB를 빈 시드 상태로 되돌립니다.
이 명령은 **모든 제휴 신청·승인 이력**을 지우므로 실제 데이터가 있는 곳에서는 쓰지 마세요.

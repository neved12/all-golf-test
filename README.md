# ALL:GOLF (시연용)

골프장 검색·시연 예약 앱, 골프장 관리자(`/partner/`), 본사 관리자(`/admin/`)로 구성된 **시연용** 프로젝트입니다.
실제 결제·실제 골프장 예약·외부 골프장 API 연동은 없습니다.

- 정적 사이트: <https://neved12.github.io/all-golf-test/> — 서버 없이 **정적 시연 모드**로 동작합니다.
- 서버 실행 시: 같은 주소에서 앱과 API·DB가 함께 동작합니다(6단계).

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

- 환경변수 `ADMIN_PASSWORD` 로 지정합니다.
- 지정하지 않으면 **시연용 기본 비밀번호 `allgolf-demo-2026`** 으로 실행되고 시작 로그에 경고가 표시됩니다.
  이 값은 저장소에 공개된 시연용 값이며 실제 운영 계정이 아닙니다.
- `.env.example` 을 `.env` 로 복사해 값을 채우면 됩니다(`.env` 는 Git 에 올라가지 않습니다).

## 모드

| 모드 | 조건 | 동작 |
|---|---|---|
| 서버 연동 | `npm start` 로 연 서버에서 접속 | 제휴 신청·승인·공개 목록이 서버 DB에 저장·공유, 관리자 API는 서버 세션 검증 |
| 정적 시연 | GitHub Pages 등 서버 없이 접속 | 네트워크 요청 없이 기존 localStorage 시연 모드. 화면 왼쪽 아래 배지로 구분 |

원격 서버에 붙이려면 `?api=https://주소` 로 한 번 접속합니다(설정은 브라우저에 기억됨).
서버 쪽에서 `ALLGOLF_ALLOWED_ORIGINS` 에 그 출처를 추가해야 합니다.

## 테스트

```bash
npm test                     # 아래 두 테스트를 모두 실행
node tests/run-scenarios.js  # 기존 회귀 120개
node tests/run-server-scenarios.js  # 6단계 서버·DB 88개 (임시 DB로 실제 서버 기동)
```

## 폴더

```
index.html, app.js, styles.css   사용자 앱
partner/                         골프장 관리자
admin/                           본사 관리자
data/                            골프장 마스터·시연 재고, 제휴 저장소, API 클라이언트
server/                          무의존성 Node API 서버 + 파일 DB
tests/                           브라우저 없이 실행하는 시나리오 테스트
```

## 데이터·백업

- 서버 DB: `server/data/db.json` (Git 제외, 개인정보 포함 가능)
- 자동 백업: 하루 1회 `server/data/backups/db-YYYY-MM-DD.json`
- 수동 백업/복구: `npm run db:backup`, `npm run db:restore -- <파일>`
- 자세한 내용: [`server/data/README.md`](server/data/README.md)

6단계 구현·검증 결과는 [ALLGOLF_6단계_완료보고서.md](ALLGOLF_6단계_완료보고서.md) 를 참고하세요.

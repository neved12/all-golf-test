#!/usr/bin/env sh
# ALL:GOLF 7단계 서버 실행 (macOS / Linux)
# 외부 패키지가 없어 npm install 이 필요하지 않습니다. Node.js 18+ 만 있으면 됩니다.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요."
  exit 1
fi
if [ ! -f .env ] && [ -f .env.example ]; then
  echo ".env 가 없어 시연용 기본값으로 실행합니다. 실제 비밀번호는 .env.example 을 .env 로 복사해 설정하세요."
fi
exec node server/index.js

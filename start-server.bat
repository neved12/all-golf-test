@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo  ALL:GOLF 7단계 서버 (시연용 - 실제 결제/예약 아님)
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js 가 설치되어 있지 않습니다.
  echo  https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo  이 프로젝트는 외부 패키지가 없어 npm install 이 필요하지 않습니다.
  pause
  exit /b 1
)
if not exist ".env" (
  if exist ".env.example" (
    echo  .env 파일이 없어 시연용 기본값으로 실행합니다.
    echo  실제 비밀번호를 쓰려면 .env.example 을 .env 로 복사해 값을 채우세요.
    echo.
  )
)
node server\index.js
echo.
echo  서버가 종료되었습니다.
pause

@echo off
chcp 65001 >nul
title AI Auto Bot - Paper Mode (Local)

echo ============================================
echo   AI Auto Bot - Paper Mode (Local)
echo   Claude CLI (Max 구독) + Gemini Free
echo ============================================
echo.

cd /d "%~dp0"

:: .env 확인
if not exist ".env" (
    echo [ERROR] .env 파일이 없습니다.
    echo   cp .env.local.example .env 후 값을 입력하세요.
    pause
    exit /b 1
)

:: Claude CLI 확인
where claude >nul 2>&1
if errorlevel 1 (
    echo [WARN] claude CLI가 설치되지 않았습니다.
    echo   npm install -g @anthropic-ai/claude-code
    echo   claude login
    echo.
    echo API 키 모드로 진행합니다...
) else (
    echo [OK] Claude CLI 감지됨 - Max 구독 토큰 사용
)

:: node_modules 확인
if not exist "node_modules" (
    echo [INFO] 의존성 설치 중...
    call npm install
)

echo.
echo [START] 서버 시작 (http://localhost:8080)
echo   Ctrl+C로 종료
echo.

:: tsx watch 모드로 실행 (자동 리로드)
call npm run dev

# 👑 QUANTOPS 세팅 가이드

## 내일 할 것 (순서대로, 총 30분)

### 1. KIS API Key 발급 (10분)
1. 한국투자증권 앱 → 모의투자 신청
2. https://apiportal.koreainvestment.com/ 접속
3. 인증서 로그인 → 모의투자 계좌로 API 신청
4. `App Key`, `App Secret`, `계좌번호(8-2)` 메모

### 2. Supabase 프로젝트 생성 (5분)
1. https://supabase.com/ 가입
2. New Project → Region: Northeast Asia (Seoul)
3. Project Settings → API에서 URL, anon key, service_role key 메모
4. SQL Editor에서 `src/db/migrations/001_initial.sql` 전체 붙여넣기 실행

### 3. AI API Key 준비 (5분)
- Gemini: https://aistudio.google.com/apikey
- OpenAI: https://platform.openai.com/api-keys
- Anthropic: https://console.anthropic.com/settings/keys

### 4. Telegram Bot 생성 (3분)
1. Telegram에서 @BotFather 채팅
2. /newbot → 이름 입력 → 토큰 메모
3. 만든 봇에 아무 메시지 보내기
4. https://api.telegram.org/bot<TOKEN>/getUpdates → chat_id 메모

### 5. .env 파일 생성 (2분)
```bash
cp .env.example .env
# 위에서 메모한 값들 입력
```

### 6. 실행!
```bash
npm run dev
```
http://localhost:8080/api/health 에서 상태 확인

### 7. 프론트엔드 실행
```bash
cd frontend && npm run dev
```
http://localhost:3000 에서 대시보드 확인

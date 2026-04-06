#!/bin/bash
# ============================================
# 👑 QUANTOPS 프로덕션 배포
# 실거래 시스템 — 성능/안정성 최우선
# ============================================

set -e

# ── 설정 ──
PROJECT_ID="quantops-trading"
ERP_PROJECT="proscom-482505"
REGION="asia-northeast3"
REPO="quantops"
SERVICE="quantops"
TAG=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/quantops"

# ────────────────────────────────────────────
# 안전 장치
# ────────────────────────────────────────────
CURRENT=$(gcloud config get-value project 2>/dev/null)
if [ "$CURRENT" = "$ERP_PROJECT" ]; then
    echo "❌ ERP 프로젝트(proscom-482505) 감지! 자동 전환..."
    gcloud config set project $PROJECT_ID
fi

if [ "$(gcloud config get-value project)" != "$PROJECT_ID" ]; then
    echo "❌ 프로젝트가 $PROJECT_ID 가 아닙니다. 중단."
    exit 1
fi

echo ""
echo "🚀 QUANTOPS 배포 시작"
echo "   프로젝트: $PROJECT_ID"
echo "   태그: $TAG"
echo "   리전: $REGION (서울)"
echo ""

# ────────────────────────────────────────────
# Docker 빌드 + Push
# ────────────────────────────────────────────
echo "🐳 [1/3] Docker 빌드..."
docker build \
    --platform linux/amd64 \
    -t ${IMAGE}:${TAG} \
    -t ${IMAGE}:latest \
    .

echo "📤 [2/3] 이미지 Push..."
docker push ${IMAGE}:${TAG}
docker push ${IMAGE}:latest

# ────────────────────────────────────────────
# Cloud Run 배포 (실거래 최적화 설정)
# ────────────────────────────────────────────
echo "☁️  [3/3] Cloud Run 배포 (성능 최적화)..."
gcloud run deploy $SERVICE \
    --image=${IMAGE}:${TAG} \
    --region=$REGION \
    --platform=managed \
    --min-instances=1 \
    --max-instances=1 \
    --memory=1Gi \
    --cpu=1 \
    --port=8080 \
    --timeout=300s \
    --concurrency=80 \
    --no-cpu-throttling \
    --allow-unauthenticated \
    --set-env-vars="NODE_ENV=production,TRADING_MODE=paper" \
    --set-secrets="\
KIS_APP_KEY=kis-app-key:latest,\
KIS_APP_SECRET=kis-app-secret:latest,\
KIS_ACCOUNT_NO=kis-account-no:latest,\
KIS_BASE_URL=kis-base-url:latest,\
SUPABASE_URL=supabase-url:latest,\
SUPABASE_ANON_KEY=supabase-anon-key:latest,\
SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,\
GEMINI_API_KEY=gemini-api-key:latest,\
OPENAI_API_KEY=openai-api-key:latest,\
ANTHROPIC_API_KEY=anthropic-api-key:latest,\
TELEGRAM_BOT_TOKEN=telegram-bot-token:latest,\
TELEGRAM_CHAT_ID=telegram-chat-id:latest\
" \
    --set-env-vars="\
RISK_MAX_DAILY_DRAWDOWN_KRW=50000,\
RISK_MAX_POSITION_KRW=300000,\
RISK_MAX_TOTAL_INVESTED_PCT=80\
"

echo ""
echo "=========================================="
echo "  ✅ 배포 완료!"
echo "=========================================="
URL=$(gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)' 2>/dev/null)
echo ""
echo "  🌐 URL: $URL"
echo "  📋 헬스: ${URL}/api/health"
echo "  📊 대시보드: ${URL}/api/dashboard"
echo ""
echo "  ⚡ Cloud Run 성능:"
echo "     CPU 항상 할당 (스케줄러 상시 가동)"
echo "     메모리 1GB (AI API 동시 호출 여유)"
echo "     인스턴스 1개 항상 대기 (콜드스타트 0)"
echo "     서울 리전 (KIS API 최소 지연)"
echo ""
echo "  🔒 현재 모드: PAPER (모의투자)"
echo "     실거래 전환: --set-env-vars=TRADING_MODE=live"
echo ""

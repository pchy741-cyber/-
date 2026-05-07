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
# Cloud Build (로컬 Docker 불필요)
# ────────────────────────────────────────────
echo "☁️  [1/3] Cloud Build 원격 빌드..."
gcloud builds submit \
    --project=$PROJECT_ID \
    --tag=${IMAGE}:${TAG} \
    --timeout=20m \
    .

echo "🏷️  [2/3] latest 태그 추가..."
gcloud artifacts docker tags add \
    ${IMAGE}:${TAG} \
    ${IMAGE}:latest \
    --project=$PROJECT_ID 2>/dev/null || true

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
    --memory=512Mi \
    --cpu=1 \
    --port=8080 \
    --timeout=300s \
    --concurrency=1 \
    --no-cpu-throttling \
    --allow-unauthenticated \
    --add-cloudsql-instances=quantops-trading:asia-northeast3:quantops-db \
    --set-env-vars="NODE_ENV=production,TRADING_MODE=paper,INSTANCE_UNIX_SOCKET=/cloudsql/quantops-trading:asia-northeast3:quantops-db,DB_DATABASE=quantops,DB_USER=postgres,RISK_MAX_DAILY_DRAWDOWN_KRW=500000,RISK_MAX_POSITION_KRW=3000000,RISK_MAX_TOTAL_INVESTED_PCT=90" \
    --set-secrets="\
KIS_APP_KEY=kis-app-key:latest,\
KIS_APP_SECRET=kis-app-secret:latest,\
KIS_ACCOUNT_NO=kis-account-no:latest,\
GEMINI_API_KEY=gemini-api-key:latest,\
OPENAI_API_KEY=openai-api-key:latest,\
ANTHROPIC_API_KEY=anthropic-api-key:latest,\
DB_PASSWORD=db-password:latest,\
DASHBOARD_PASSWORD=dashboard-password:latest\
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
echo "     CPU 1 항상 할당 (스케줄러 상시 가동, 비용 최적화 ~65,000원/월)"
echo "     메모리 1GB (AI API 동시 호출 여유)"
echo "     인스턴스 1개 항상 대기 (콜드스타트 0)"
echo "     서울 리전 (KIS API 최소 지연)"
echo ""
echo "  🔒 현재 모드: PAPER (모의투자)"
echo "     실거래 전환: --set-env-vars=TRADING_MODE=live"
echo ""

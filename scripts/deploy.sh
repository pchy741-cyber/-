#!/bin/bash
# ============================================
# 👑 AI AUTO BOT 배포 스크립트
#
# 사용법:
#   bash scripts/deploy.sh            → staging 배포 (연습모드, 트래픽 0%)
#   bash scripts/deploy.sh staging    → staging 배포 (위와 동일)
#   bash scripts/deploy.sh promote    → staging → 실전 승격 (트래픽 100%)
#   bash scripts/deploy.sh live       → 직접 실전 배포 (긴급용)
#
# 표준 워크플로우:
#   1. 코드 수정 후 → bash scripts/deploy.sh staging
#   2. staging URL로 검수 → OK 확인
#   3. bash scripts/deploy.sh promote → 실전 반영
# ============================================

set -e

# ── 설정 ──
PROJECT_ID="quantops-trading"
ERP_PROJECT="proscom-482505"
REGION="asia-northeast3"
REPO="quantops"
SERVICE="ai-auto-bot"
TAG=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/ai-auto-bot"

# 공통 secrets (staging/live 동일)
SECRETS="\
KIS_APP_KEY=kis-app-key:latest,\
KIS_APP_SECRET=kis-app-secret:latest,\
KIS_ACCOUNT_NO=kis-account-no:latest,\
KIS_APP_KEY_LIVE=kis-app-key-live:latest,\
KIS_APP_SECRET_LIVE=kis-app-secret-live:latest,\
KIS_ACCOUNT_NO_LIVE=kis-account-no-live:latest,\
GEMINI_API_KEY=gemini-api-key:latest,\
OPENAI_API_KEY=openai-api-key:latest,\
ANTHROPIC_API_KEY=anthropic-api-key:latest,\
DB_PASSWORD=db-password:latest,\
DASHBOARD_PASSWORD=dashboard-password:latest,\
VAPID_PUBLIC_KEY=vapid-public-key:latest,\
VAPID_PRIVATE_KEY=vapid-private-key:latest"

# Cloud Run 공통 옵션
COMMON_RUN_OPTS="\
    --region=$REGION \
    --platform=managed \
    --max-instances=1 \
    --memory=512Mi \
    --cpu=1 \
    --port=8080 \
    --timeout=300s \
    --concurrency=80 \
    --allow-unauthenticated \
    --add-cloudsql-instances=quantops-trading:asia-northeast3:quantops-db"

# 실전: min-instances=1 (콜드스타트 0, 스케줄러 상시 가동)
LIVE_INSTANCES="--min-instances=1"
# staging: min-instances=0 (트래픽 없음 → 서버비 0, 테스트 시에만 warm-up)
STAGING_INSTANCES="--min-instances=0"

BASE_ENV="NODE_ENV=production,INSTANCE_UNIX_SOCKET=/cloudsql/quantops-trading:asia-northeast3:quantops-db,DB_NAME=quantops,DB_USER=postgres,RISK_MAX_DAILY_DRAWDOWN_KRW=500000,RISK_MAX_POSITION_KRW=3000000,RISK_MAX_TOTAL_INVESTED_PCT=90"

CMD="${1:-staging}"

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

# ────────────────────────────────────────────
# promote: staging revision → 실전 트래픽 100%
# ────────────────────────────────────────────
if [ "$CMD" = "promote" ]; then
    echo ""
    echo "🚀 STAGING → LIVE 승격"
    echo ""

    # staging 태그가 달린 revision 확인
    STAGING_REV=$(gcloud run services describe $SERVICE \
        --region=$REGION \
        --format="value(spec.traffic[?tag='staging'].revisionName)" 2>/dev/null | head -1)

    if [ -z "$STAGING_REV" ]; then
        echo "❌ staging revision 없음. 먼저 'bash scripts/deploy.sh staging' 실행 필요."
        exit 1
    fi

    echo "   staging revision: $STAGING_REV"
    echo "   트래픽 100% 이동 중..."

    gcloud run services update-traffic $SERVICE \
        --region=$REGION \
        --to-revisions="${STAGING_REV}=100" \
        --remove-tags=staging

    URL=$(gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)' 2>/dev/null)
    echo ""
    echo "=========================================="
    echo "  ✅ 승격 완료! 실전 서비스 업데이트됨"
    echo "=========================================="
    echo "  🌐 실전 URL: $URL"
    echo ""
    exit 0
fi

# ────────────────────────────────────────────
# staging 또는 live: 빌드 후 배포
# ────────────────────────────────────────────
echo ""
if [ "$CMD" = "live" ]; then
    echo "🚀 AI AUTO BOT 실전 직접 배포 (긴급)"
else
    echo "🧪 AI AUTO BOT STAGING 배포 (연습모드 검수)"
fi
echo "   프로젝트: $PROJECT_ID"
echo "   태그: $TAG"
echo "   리전: $REGION (서울)"
echo ""

# [1/3] 빌드
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

# [3/3] Cloud Run 배포
echo "☁️  [3/3] Cloud Run 배포..."

if [ "$CMD" = "live" ]; then
    # 직접 실전 배포 — 트래픽 100%, TRADING_MODE=live, min-instances=1
    gcloud run deploy $SERVICE \
        --image=${IMAGE}:${TAG} \
        $COMMON_RUN_OPTS \
        $LIVE_INSTANCES \
        --set-env-vars="${BASE_ENV},TRADING_MODE=live" \
        --set-secrets="$SECRETS"

    URL=$(gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)' 2>/dev/null)
    echo ""
    echo "=========================================="
    echo "  ✅ 실전 배포 완료!"
    echo "=========================================="
    echo "  🌐 URL: $URL"
    echo "  🟢 모드: LIVE"
    echo ""
else
    # staging 배포 — 트래픽 0%, tag=staging, TRADING_MODE=paper, min-instances=0 (서버비 0)
    gcloud run deploy $SERVICE \
        --image=${IMAGE}:${TAG} \
        $COMMON_RUN_OPTS \
        $STAGING_INSTANCES \
        --set-env-vars="${BASE_ENV},TRADING_MODE=paper" \
        --set-secrets="$SECRETS" \
        --no-traffic \
        --tag=staging

    STAGING_URL=$(gcloud run services describe $SERVICE \
        --region=$REGION \
        --format="value(status.traffic[?tag='staging'].url)" 2>/dev/null | head -1)
    PROD_URL=$(gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)' 2>/dev/null)

    echo ""
    echo "=========================================="
    echo "  ✅ STAGING 배포 완료!"
    echo "=========================================="
    echo "  🧪 검수 URL:  ${STAGING_URL}"
    echo "  🌐 실전 URL:  ${PROD_URL}  (기존 그대로)"
    echo ""
    echo "  검수 후 승격:"
    echo "  bash scripts/deploy.sh promote"
    echo ""
fi

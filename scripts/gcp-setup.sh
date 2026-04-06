#!/bin/bash
# ============================================
# 👑 QUANTOPS GCP 프로덕션 세팅
# 실제 매매 시스템 — 성능/안정성 최우선
# proscom-482505 (ERP) 절대 건드리지 않음
# ============================================

set -e

# ── 설정값 ──
ORG_DOMAIN="proscom-hr.com"
ERP_PROJECT="proscom-482505"           # ⛔ ERP — 절대 건드리지 않음!
PROJECT_ID="quantops-trading"
REGION="asia-northeast3"               # 서울 (KIS API 서버와 같은 리전 → 최소 지연)
SERVICE_NAME="quantops"
REPO_NAME="quantops"

# ── Cloud Run 성능 설정 (실거래 최적화) ──
CLOUD_RUN_MEMORY="1Gi"                 # 1GB (AI API 동시 호출 + JSON 파싱 여유)
CLOUD_RUN_CPU="1"                      # vCPU 1개 (스케줄러 + Express 충분)
MIN_INSTANCES="1"                      # 콜드스타트 방지: 항상 1개 인스턴스 대기
MAX_INSTANCES="1"                      # 돈 다루므로 동시성 방지 → 반드시 1개만
CONCURRENCY="80"                       # 인스턴스당 동시 요청 (대시보드 API용)
REQUEST_TIMEOUT="300s"                 # AI API 호출이 오래 걸릴 수 있음 (5분)
CPU_THROTTLING="false"                 # ⭐ CPU 항상 할당 (스케줄러가 백그라운드 상시 실행)

echo ""
echo "=========================================="
echo "  👑 QUANTOPS 프로덕션 GCP 세팅"
echo "  실제 매매 시스템 — 성능/안정성 최우선"
echo "=========================================="
echo ""
echo "  📌 ERP(proscom-482505)는 절대 건드리지 않습니다."
echo "  📌 새 프로젝트: quantops-trading"
echo ""

# ────────────────────────────────────────────
# 안전 장치: ERP 프로젝트로 실수 방지
# ────────────────────────────────────────────
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null)
if [ "$CURRENT_PROJECT" = "$ERP_PROJECT" ]; then
    echo "⚠️  현재 ERP 프로젝트 활성 상태 → QUANTOPS로 전환합니다."
fi

# ────────────────────────────────────────────
# Step 1: 프로젝트 생성
# ────────────────────────────────────────────
echo "📦 [1/7] 프로젝트 생성..."

# 조직 ID 조회
ORG_ID=$(gcloud organizations list --format="value(ID)" --filter="displayName~$ORG_DOMAIN" 2>/dev/null | head -1)

if [ -n "$ORG_ID" ]; then
    gcloud projects create $PROJECT_ID \
        --name="QUANTOPS Trading" \
        --organization=$ORG_ID \
        2>/dev/null && echo "   ✅ 프로젝트 생성 완료" || echo "   → 이미 존재, 계속 진행"
else
    gcloud projects create $PROJECT_ID \
        --name="QUANTOPS Trading" \
        2>/dev/null && echo "   ✅ 프로젝트 생성 완료" || echo "   → 이미 존재, 계속 진행"
fi

# ────────────────────────────────────────────
# Step 2: 프로젝트 전환
# ────────────────────────────────────────────
echo "🔄 [2/7] QUANTOPS 프로젝트로 전환..."
gcloud config set project $PROJECT_ID
echo "   ✅ 현재 프로젝트: $(gcloud config get-value project)"

# ────────────────────────────────────────────
# Step 3: 결제 연결
# ────────────────────────────────────────────
echo "💳 [3/7] 결제 계정 연결..."
BILLING_ACCOUNT=$(gcloud billing accounts list --format="value(ACCOUNT_ID)" --limit=1 2>/dev/null)
if [ -n "$BILLING_ACCOUNT" ]; then
    gcloud billing projects link $PROJECT_ID --billing-account=$BILLING_ACCOUNT 2>/dev/null
    echo "   ✅ 결제 연결: $BILLING_ACCOUNT"
else
    echo "   ⚠️  결제 계정을 GCP 콘솔에서 수동 연결 필요"
fi

# ────────────────────────────────────────────
# Step 4: API 활성화
# ────────────────────────────────────────────
echo "🔌 [4/7] API 활성화..."
gcloud services enable \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    secretmanager.googleapis.com \
    --project=$PROJECT_ID

echo "   ✅ Cloud Run + Artifact Registry + Cloud Build + Secret Manager"
echo "   ❌ Firebase API는 건드리지 않음"

# ────────────────────────────────────────────
# Step 5: Artifact Registry (Docker 이미지 저장소)
# ────────────────────────────────────────────
echo "🐳 [5/7] Docker 저장소 생성..."
gcloud artifacts repositories create $REPO_NAME \
    --repository-format=docker \
    --location=$REGION \
    --description="QUANTOPS Trading System" \
    --project=$PROJECT_ID 2>/dev/null && echo "   ✅ 저장소 생성 완료" || echo "   → 이미 존재"

# Docker 인증 설정
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

# ────────────────────────────────────────────
# Step 6: Secret Manager (API 키 보관)
# ────────────────────────────────────────────
echo "🔐 [6/7] Secret Manager 설정..."
echo "   API 키/시크릿은 .env가 아닌 Secret Manager에 안전하게 보관합니다."
echo ""

# 시크릿 목록 (빈 값으로 생성 → 나중에 값 입력)
SECRETS=(
    "kis-app-key"
    "kis-app-secret"
    "kis-account-no"
    "kis-base-url"
    "supabase-url"
    "supabase-anon-key"
    "supabase-service-role-key"
    "gemini-api-key"
    "openai-api-key"
    "anthropic-api-key"
    "telegram-bot-token"
    "telegram-chat-id"
)

for secret in "${SECRETS[@]}"; do
    if ! gcloud secrets describe $secret --project=$PROJECT_ID &>/dev/null; then
        echo "placeholder" | gcloud secrets create $secret \
            --data-file=- \
            --replication-policy=user-managed \
            --locations=$REGION \
            --project=$PROJECT_ID 2>/dev/null
        echo "   📝 시크릿 생성: $secret (값 입력 필요)"
    else
        echo "   → 시크릿 존재: $secret"
    fi
done

# Cloud Run 서비스 계정에 시크릿 읽기 권한 부여
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet 2>/dev/null

echo "   ✅ Cloud Run → Secret Manager 접근 권한 부여 완료"

# ────────────────────────────────────────────
# Step 7: Cloud Run 서비스 사전 설정
# ────────────────────────────────────────────
echo "⚡ [7/7] Cloud Run 성능 최적화 설정..."
echo ""
echo "   ┌─────────────────────────────────────────┐"
echo "   │  💰 실거래 시스템 성능 설정              │"
echo "   ├─────────────────────────────────────────┤"
echo "   │  메모리:     $CLOUD_RUN_MEMORY (AI 동시 호출 여유)   │"
echo "   │  CPU:        $CLOUD_RUN_CPU vCPU                      │"
echo "   │  최소 인스턴스: $MIN_INSTANCES (콜드스타트 0)            │"
echo "   │  최대 인스턴스: $MAX_INSTANCES (동시성 충돌 방지)        │"
echo "   │  CPU 항상 할당: Yes (스케줄러 상시 가동)   │"
echo "   │  타임아웃:   $REQUEST_TIMEOUT (AI API 대기)         │"
echo "   │  리전:       $REGION (서울, KIS 최소 지연)│"
echo "   └─────────────────────────────────────────┘"
echo ""

# ────────────────────────────────────────────
# 완료 요약
# ────────────────────────────────────────────
echo "=========================================="
echo "  ✅ GCP 인프라 준비 완료!"
echo "=========================================="
echo ""
echo "📋 남은 단계:"
echo ""
echo "  1️⃣  Secret Manager에 실제 API 키 입력:"
echo "     각 시크릿에 실제 값을 넣으세요:"
echo ""
echo "     echo 'YOUR_KIS_APP_KEY' | gcloud secrets versions add kis-app-key --data-file=-"
echo "     echo 'YOUR_KIS_APP_SECRET' | gcloud secrets versions add kis-app-secret --data-file=-"
echo "     echo '12345678-01' | gcloud secrets versions add kis-account-no --data-file=-"
echo "     echo 'https://xxx.supabase.co' | gcloud secrets versions add supabase-url --data-file=-"
echo "     ... (나머지 시크릿도 동일)"
echo ""
echo "  2️⃣  Docker 빌드 + 배포:"
echo "     bash scripts/deploy.sh"
echo ""
echo "💰 예상 월 비용:"
echo "   Cloud Run (1vCPU, 1GB, 항상 가동): ~\$15-20/월"
echo "   Secret Manager: ~\$0.06/월 (무시해도 됨)"
echo "   Artifact Registry: ~\$0.10/월 (무시해도 됨)"
echo "   Supabase Free Tier: \$0"
echo "   ────────────────"
echo "   합계: 약 \$15-20/월 (≈ 2만~3만원)"
echo ""
echo "🔒 proscom-482505 (ERP): 전혀 영향 없음"
echo ""
echo "⚠️  매매 시스템 운영 수칙:"
echo "   1. 반드시 PAPER 모드로 1-3개월 검증 후 실거래 전환"
echo "   2. 시크릿 값은 절대 코드에 하드코딩 하지 말 것"
echo "   3. 배포 전 항상 gcloud config get-value project 로 프로젝트 확인"

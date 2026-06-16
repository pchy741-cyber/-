#!/bin/bash
# v10.5 Live 매매 상태 점검 (최근 N분 로그 요약)
# 사용법: bash scripts/check-live-status.sh [분]
#   기본 30분

PROJECT=quantops-trading
MINS=${1:-30}

echo "=== 최근 ${MINS}분 Live 매매 상태 ==="
echo ""

echo "── 1. blockNewBuys 차단 여부 ──"
gcloud logging read \
  "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"ai-auto-bot\" textPayload=~\"blockNewBuys|신규매수 차단|블로커\"" \
  --project=$PROJECT --limit=10 --freshness=${MINS}m \
  --format='csv[no-heading](timestamp.date("%H:%M:%S"),textPayload)' 2>/dev/null | head -10
echo ""

echo "── 2. KOSPI 레짐 ──"
gcloud logging read \
  "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"ai-auto-bot\" textPayload=~\"KOSPI|REGIME|penalty|todayDown\"" \
  --project=$PROJECT --limit=5 --freshness=${MINS}m \
  --format='csv[no-heading](timestamp.date("%H:%M:%S"),textPayload)' 2>/dev/null | head -5
echo ""

echo "── 3. Live 매수/매도 결정 ──"
gcloud logging read \
  "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"ai-auto-bot\" textPayload=~\"\\[LIVE\\].*Track B 완료|매수결정|매도결정\"" \
  --project=$PROJECT --limit=10 --freshness=${MINS}m \
  --format='csv[no-heading](timestamp.date("%H:%M:%S"),textPayload)' 2>/dev/null | head -10
echo ""

echo "── 4. 체결 내역 ──"
gcloud logging read \
  "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"ai-auto-bot\" textPayload=~\"체결|FILLED|BUY.*실행|SELL.*실행\"" \
  --project=$PROJECT --limit=10 --freshness=${MINS}m \
  --format='csv[no-heading](timestamp.date("%H:%M:%S"),textPayload)' 2>/dev/null | head -10
echo ""

echo "── 5. 에러 ──"
gcloud logging read \
  "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"ai-auto-bot\" severity>=ERROR" \
  --project=$PROJECT --limit=5 --freshness=${MINS}m \
  --format='csv[no-heading](timestamp.date("%H:%M:%S"),textPayload)' 2>/dev/null | head -5
echo ""
echo "=== 점검 완료 ==="

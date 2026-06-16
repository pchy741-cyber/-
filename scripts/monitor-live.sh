#!/bin/bash
# v10.5 Live 매매 실시간 모니터링
# 사용법: bash scripts/monitor-live.sh
#
# 필터: LIVE 파이프라인 로그만 (blockNewBuys, 매수/매도 결정, 에러 등)

PROJECT=quantops-trading
SERVICE=ai-auto-bot

echo "=== Live 매매 실시간 모니터링 시작 ==="
echo "  서비스: $SERVICE"
echo "  프로젝트: $PROJECT"
echo "  Ctrl+C 로 종료"
echo ""

gcloud logging tail \
  'resource.type="cloud_run_revision" resource.labels.service_name="ai-auto-bot" (textPayload=~"LIVE" OR textPayload=~"blockNewBuys" OR textPayload=~"매수" OR textPayload=~"매도" OR textPayload=~"Track B" OR textPayload=~"REGIME" OR textPayload=~"ERROR" OR textPayload=~"KOSPI" OR textPayload=~"체결" OR textPayload=~"ENTRY_TIMING" OR textPayload=~"decision" OR textPayload=~"RECONCILER")' \
  --project=$PROJECT \
  --format='value(timestamp.date("%H:%M:%S"),textPayload)' \
  --buffer-window=10s

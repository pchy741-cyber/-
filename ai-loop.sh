#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# AI Loop — Claude Code가 실행하는 매매 분석 + 조절 스크립트
#
# 사용법:
#   bash ai-loop.sh                    # paper 스냅샷 + 판단큐
#   bash ai-loop.sh live               # live 스냅샷 + 판단큐
#   bash ai-loop.sh paper command.json # 명령 실행
#   bash ai-loop.sh paper '{"commands":[...]}' # 인라인 명령
#   bash ai-loop.sh paper decide       # 판단큐만 조회
# ───────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="https://ai-auto-bot-807105550136.asia-northeast3.run.app"
MODE="${1:-paper}"
CMD="${2:-}"

# API 키 로드
if [[ -f "$SCRIPT_DIR/.api-key" ]]; then
  API_KEY=$(cat "$SCRIPT_DIR/.api-key")
elif command -v gcloud &>/dev/null; then
  API_KEY=$(gcloud secrets versions access latest --secret=dashboard-password --project=quantops-trading 2>/dev/null)
else
  echo "ERROR: .api-key 파일 없음 & gcloud 미설치"
  exit 1
fi

CURL_OPTS=(-s --max-time 30 -H "x-api-key: $API_KEY" -H "Accept: application/json")

if [[ "$CMD" == "decide" ]]; then
  # ── 판단큐만 조회 ──────────────────────────────────────
  echo "=== Pending Decisions (${MODE}) ==="
  curl "${CURL_OPTS[@]}" "$URL/api/ai-loop/pending?viewMode=$MODE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"Mode: {d['mode']} | Pending: {d['pending']}\")
for dec in d['decisions']:
    u = {1:'URGENT', 2:'NORMAL', 3:'LOW'}
    print(f\"\n[#{dec['id']}] [{u.get(dec['urgency'],'?')}] {dec['situation']}\")
    ctx = dec.get('context', {})
    if ctx.get('question'):
        print(f\"  Q: {ctx['question']}\")
    for k,v in ctx.items():
        if k != 'question':
            print(f\"  {k}: {v}\")
if not d['decisions']:
    print('  (no pending decisions)')
"

elif [[ -z "$CMD" ]]; then
  # ── 스냅샷 + 판단큐 통합 ──────────────────────────────
  echo "=== AI Loop Snapshot (${MODE}) ==="
  curl "${CURL_OPTS[@]}" "$URL/api/ai-loop/snapshot?viewMode=$MODE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"Mode: {d['mode']} | Time: {d['timestamp']}\")
print(f\"Kill Switch: KR={'ON' if d['killSwitch']['kr'] else 'off'}, US={'ON' if d['killSwitch']['overseas'] else 'off'}\")
b = d.get('balance')
if b:
    print(f\"Balance: total={b['totalAsset']:,.0f} cash={b['cash']:,.0f} invested={b['invested']:,.0f} pnl={b['profitLoss']:,.0f}\")
r = d.get('regime')
if r:
    print(f\"Regime: {json.dumps(r)}\")
cns = d.get('consensus')
if cns:
    print(f\"Consensus: {cns}\")
perf = d.get('performance', {}).get('last30d', {})
if perf.get('totalTrades'):
    print(f\"30D Performance: {perf['totalTrades']}trades, WR={perf['winRate']}%, avgPnl={perf['avgPnl']}%\")
print()
pos = d.get('positions', [])
if pos:
    print(f'--- Domestic Positions ({len(pos)}) ---')
    for p in pos:
        print(f\"  {p['stockCode']} {p['stockName']}: qty={p['quantity']} avg={p['avgBuyPrice']} strat={p['strategy']}\")
opos = d.get('overseasPositions', [])
if opos:
    print(f'--- Overseas Positions ({len(opos)}) ---')
    for p in opos:
        print(f\"  {p['stockCode']}: qty={p['quantity']} avg=\${p['avgPrice']:.2f}\")
overrides = d.get('activeOverrides', [])
if overrides:
    print(f'--- Active Overrides ({len(overrides)}) ---')
    for o in overrides:
        print(f\"  [{o['category']}] {o['key']}={o['value']}\")
trades = d.get('recentTrades', [])
if trades:
    print(f'--- Recent Trades ({len(trades)}) ---')
    for t in trades[:5]:
        icon = '+' if t['pnlPct'] > 0 else '-'
        print(f\"  {icon} {t['stockCode']}: {t['pnlPct']:+.1f}% [{t['strategy']}]\")
"
  # 판단큐도 함께 출력
  echo ""
  echo "=== Pending Decisions ==="
  curl "${CURL_OPTS[@]}" "$URL/api/ai-loop/pending?viewMode=$MODE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
u = {1:'URGENT', 2:'NORMAL', 3:'LOW'}
if not d['decisions']:
    print('  (no pending decisions - all clear)')
else:
    for dec in d['decisions']:
        print(f\"[#{dec['id']}] [{u.get(dec['urgency'],'?')}] {dec['situation']}\")
        ctx = dec.get('context', {})
        if ctx.get('question'):
            print(f\"  Q: {ctx['question']}\")
"

else
  # ── 명령 모드 ──────────────────────────────────────────
  if [[ -f "$CMD" ]]; then
    BODY=$(cat "$CMD")
  else
    BODY="$CMD"
  fi
  echo "=== AI Loop Command (${MODE}) ==="
  curl "${CURL_OPTS[@]}" -X POST \
    -H "Content-Type: application/json" \
    "$URL/api/ai-loop/command?viewMode=$MODE" \
    -d "$BODY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"Processed: {d['processed']} | OK: {d['ok']} | Fail: {d['fail']}\")
for r in d.get('results', []):
    status = 'OK' if r['ok'] else f\"FAIL: {r.get('error','')}\"
    print(f\"  {r['key']}: {status}\")
"
fi

import sys, json, os

def fmt_snap(path):
    d = json.load(open(path, 'r', encoding='utf-8'))
    print(f"Mode: {d['mode']} | Time: {d['timestamp']}")
    ks = d['killSwitch']
    print(f"Kill Switch: KR={'ON' if ks['kr'] else 'off'}, US={'ON' if ks['overseas'] else 'off'}")
    b = d.get('balance')
    if b:
        print(f"Balance: total={b['totalAsset']:,.0f} cash={b['cash']:,.0f} invested={b['invested']:,.0f} pnl={b['profitLoss']:,.0f}")
        dom = b.get('_domestic')
        ovs = b.get('_overseas')
        if dom and ovs:
            print(f"  [KR] cash={dom['cash']:,.0f} invested={dom['invested']:,.0f}")
            print(f"  [US] cashKrw={ovs['cashKrw']:,.0f} investedKrw={ovs['investedKrw']:,.0f} FX={ovs['fxRate']:.0f}")
    r = d.get('regime')
    if r:
        print(f"Regime: {json.dumps(r)}")
    c = d.get('consensus')
    if c:
        print(f"Consensus: {json.dumps(c)}")
    pf = d.get('performance', {}).get('last30d', {})
    if pf.get('totalTrades'):
        print(f"30D: {pf['totalTrades']}trades WR={pf['winRate']}% avg={pf['avgPnl']}%")
    print()
    pos = d.get('positions', [])
    if pos:
        print(f"--- Domestic Positions ({len(pos)}) ---")
        for p in pos:
            print(f"  {p['stockCode']} {p['stockName']}: qty={p['quantity']} avg={p['avgBuyPrice']} strat={p['strategy']}")
    opos = d.get('overseasPositions', [])
    if opos:
        print(f"--- Overseas Positions ({len(opos)}) ---")
        for p in opos:
            print(f"  {p['stockCode']}: qty={p['quantity']} avg=${p['avgPrice']:.2f}")
    ov = d.get('activeOverrides', [])
    if ov:
        print(f"--- Active Overrides ({len(ov)}) ---")
        for o in ov:
            print(f"  [{o['category']}] {o['key']}={o['value']}")
    tr = d.get('recentTrades', [])
    if tr:
        print(f"--- Recent Trades ({len(tr)}) ---")
        for t in tr[:5]:
            icon = '+' if t['pnlPct'] > 0 else '-'
            print(f"  {icon} {t['stockCode']}: {t['pnlPct']:+.1f}% [{t['strategy']}]")

def fmt_pending(path):
    d = json.load(open(path, 'r', encoding='utf-8'))
    decs = d.get('decisions', [])
    u = {1: 'URGENT', 2: 'NORMAL', 3: 'LOW'}
    if not decs:
        print("  (no pending decisions - all clear)")
        return
    for dc in decs:
        print(f"[#{dc['id']}] [{u.get(dc['urgency'],'?')}] {dc['situation']}")
        ctx = dc.get('context', {})
        if ctx.get('question'):
            print(f"  Q: {ctx['question']}")

def fmt_cmd(path):
    d = json.load(open(path, 'r', encoding='utf-8'))
    print(f"Processed: {d['processed']} | OK: {d['ok']} | Fail: {d['fail']}")
    for r in d.get('results', []):
        st = 'OK' if r['ok'] else f"FAIL: {r.get('error','')}"
        print(f"  {r['key']}: {st}")

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'snap'
    path = sys.argv[2] if len(sys.argv) > 2 else ''
    if mode == 'snap':
        fmt_snap(path)
    elif mode == 'pending':
        fmt_pending(path)
    elif mode == 'cmd':
        fmt_cmd(path)

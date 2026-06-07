# AI Loop (PowerShell)
# .\ai-loop.ps1              # paper
# .\ai-loop.ps1 live         # live
# .\ai-loop.ps1 paper decide # 판단큐
# .\ai-loop.ps1 paper '{"commands":[...]}' # 명령
param(
  [string]$Mode = "paper",
  [string]$Cmd = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Url = "https://ai-auto-bot-ang2aozjiq-du.a.run.app"

# API 키 로드
$keyFile = Join-Path $ScriptDir ".api-key"
if (Test-Path $keyFile) {
  $ApiKey = (Get-Content $keyFile -Raw).Trim()
}
elseif (Get-Command gcloud -ErrorAction SilentlyContinue) {
  $ApiKey = gcloud secrets versions access latest --secret=dashboard-password --project=quantops-trading 2>$null
}
else {
  Write-Error ".api-key 파일 없음 and gcloud 미설치"
  exit 1
}

$Headers = @{
  "x-api-key" = $ApiKey
  "Accept"    = "application/json"
}

function Invoke-Api {
  param([string]$Path, [string]$Method = "GET", [string]$Body = $null)
  $uri = $Url + $Path
  $p = @{ Uri = $uri; Headers = $Headers; Method = $Method; TimeoutSec = 30; UseBasicParsing = $true }
  if ($Body) {
    $p["Body"] = $Body
    $p["ContentType"] = "application/json"
  }
  try {
    $resp = Invoke-WebRequest @p
    return $resp.Content | ConvertFrom-Json
  }
  catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    return $null
  }
}

function Show-Snapshot {
  param($d)
  if (-not $d) { Write-Host "snapshot failed" -ForegroundColor Red; return }

  Write-Host ('=== AI Loop Snapshot (' + $d.mode + ') ===') -ForegroundColor Cyan
  Write-Host ('Time: ' + $d.timestamp)

  $ks = $d.killSwitch
  $krTxt = 'off'; if ($ks.kr) { $krTxt = 'ON' }
  $usTxt = 'off'; if ($ks.overseas) { $usTxt = 'ON' }
  Write-Host ('Kill Switch: KR=' + $krTxt + ', US=' + $usTxt)

  $b = $d.balance
  if ($b) {
    Write-Host ('Balance: total=' + [string]::Format('{0:N0}', $b.totalAsset) + ' cash=' + [string]::Format('{0:N0}', $b.cash) + ' invested=' + [string]::Format('{0:N0}', $b.invested) + ' pnl=' + [string]::Format('{0:N0}', $b.profitLoss))
  }

  if ($d.regime) {
    Write-Host ('Regime: ' + ($d.regime | ConvertTo-Json -Compress))
  }
  if ($d.consensus) {
    Write-Host ('Consensus: ' + ($d.consensus | ConvertTo-Json -Compress))
  }

  $perf = $null
  if ($d.performance) { $perf = $d.performance.last30d }
  if ($perf -and $perf.totalTrades) {
    Write-Host ('30D: ' + $perf.totalTrades + 'trades, WR=' + $perf.winRate + '%, avgPnl=' + $perf.avgPnl + '%')
  }

  Write-Host ''

  $pos = $d.positions
  if ($pos -and $pos.Count -gt 0) {
    Write-Host ('--- Domestic Positions (' + $pos.Count + ') ---') -ForegroundColor Yellow
    foreach ($p in $pos) {
      Write-Host ('  ' + $p.stockCode + ' ' + $p.stockName + ': qty=' + $p.quantity + ' avg=' + $p.avgBuyPrice + ' strat=' + $p.strategy)
    }
  }

  $opos = $d.overseasPositions
  if ($opos -and $opos.Count -gt 0) {
    Write-Host ('--- Overseas Positions (' + $opos.Count + ') ---') -ForegroundColor Yellow
    foreach ($p in $opos) {
      $avgStr = [string]::Format('{0:F2}', [double]$p.avgPrice)
      Write-Host ('  ' + $p.stockCode + ': qty=' + $p.quantity + ' avg=$' + $avgStr)
    }
  }

  $ov = $d.activeOverrides
  if ($ov -and $ov.Count -gt 0) {
    Write-Host ('--- Active Overrides (' + $ov.Count + ') ---') -ForegroundColor Yellow
    foreach ($o in $ov) {
      Write-Host ('  [' + $o.category + '] ' + $o.key + '=' + $o.value)
    }
  }

  $trades = $d.recentTrades
  if ($trades -and $trades.Count -gt 0) {
    Write-Host ('--- Recent Trades (' + $trades.Count + ') ---') -ForegroundColor Yellow
    $top5 = $trades | Select-Object -First 5
    foreach ($t in $top5) {
      $icon = '-'; if ($t.pnlPct -gt 0) { $icon = '+' }
      $pnlStr = [string]::Format('{0:+0.0;-0.0}', [double]$t.pnlPct)
      Write-Host ('  ' + $icon + ' ' + $t.stockCode + ': ' + $pnlStr + '% [' + $t.strategy + ']')
    }
  }
}

function Show-Pending {
  param($d)
  if (-not $d) { return }
  Write-Host ''
  Write-Host '=== Pending Decisions ===' -ForegroundColor Cyan
  if (-not $d.decisions -or $d.decisions.Count -eq 0) {
    Write-Host '  (no pending decisions - all clear)' -ForegroundColor Green
    return
  }
  $urgMap = @{ 1 = 'URGENT'; 2 = 'NORMAL'; 3 = 'LOW' }
  foreach ($dec in $d.decisions) {
    $urg = $urgMap[[int]$dec.urgency]
    if (-not $urg) { $urg = '?' }
    Write-Host ('[#' + $dec.id + '] [' + $urg + '] ' + $dec.situation) -ForegroundColor White
    if ($dec.context -and $dec.context.question) {
      Write-Host ('  Q: ' + $dec.context.question) -ForegroundColor Gray
    }
  }
}

# ── main ──
if ($Cmd -eq 'decide') {
  $d = Invoke-Api ('/api/ai-loop/pending?viewMode=' + $Mode)
  if ($d) {
    Write-Host ('=== Pending Decisions (' + $Mode + ') ===') -ForegroundColor Cyan
    Write-Host ('Mode: ' + $d.mode + ' | Pending: ' + $d.pending)
    if (-not $d.decisions -or $d.decisions.Count -eq 0) {
      Write-Host '  (no pending decisions)'
    }
    else {
      $urgMap = @{ 1 = 'URGENT'; 2 = 'NORMAL'; 3 = 'LOW' }
      foreach ($dec in $d.decisions) {
        $urg = $urgMap[[int]$dec.urgency]
        if (-not $urg) { $urg = '?' }
        Write-Host ('[#' + $dec.id + '] [' + $urg + '] ' + $dec.situation)
        if ($dec.context -and $dec.context.question) {
          Write-Host ('  Q: ' + $dec.context.question)
        }
      }
    }
  }
}
elseif ($Cmd -eq '') {
  $snap = Invoke-Api ('/api/ai-loop/snapshot?viewMode=' + $Mode)
  Show-Snapshot $snap
  $pend = Invoke-Api ('/api/ai-loop/pending?viewMode=' + $Mode)
  Show-Pending $pend
}
else {
  $body = $Cmd
  if (Test-Path $Cmd -ErrorAction SilentlyContinue) {
    $body = Get-Content $Cmd -Raw
  }
  Write-Host ('=== AI Loop Command (' + $Mode + ') ===') -ForegroundColor Cyan
  $d = Invoke-Api ('/api/ai-loop/command?viewMode=' + $Mode) -Method 'POST' -Body $body
  if ($d) {
    Write-Host ('Processed: ' + $d.processed + ' | OK: ' + $d.ok + ' | Fail: ' + $d.fail)
    foreach ($r in $d.results) {
      $st = 'OK'
      if (-not $r.ok) { $st = 'FAIL: ' + $r.error }
      Write-Host ('  ' + $r.key + ': ' + $st)
    }
  }
}

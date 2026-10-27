# 健壮性验证：用量埋点 / 改口冲突 / 并发串行
# 用法： pwsh -File scripts/robust-check.ps1

param([string]$Base = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'

function New-Body {
  param([string]$Conv, [string]$Mid, [string]$Text)
  $m = Invoke-RestMethod "$Base/api/mock/subject?job=job-a&candidate=cand-zhangwei"
  $m.request.conversationId = $Conv
  $m.request.messageId = $Mid
  $m.request.message.text = $Text
  $m.request.subject.candidate | Add-Member snapshot $m.candidate -Force
  $m.request.subject.jobOrder | Add-Member snapshot $m.job -Force
  return ($m.request | ConvertTo-Json -Depth 30 -Compress)
}

function Reset-Conv([string]$Conv) {
  try { Invoke-WebRequest -Uri "$Base/api/v1/messages?conversationId=$Conv" -Method DELETE -UseBasicParsing -TimeoutSec 10 | Out-Null } catch { }
}

Write-Host ''
Write-Host '=== 1. 用量埋点' -ForegroundColor Cyan
Reset-Conv 'rb-usage'
$body = New-Body 'rb-usage' 'u1' '还招人吗'
$r = Invoke-WebRequest -Uri "$Base/api/v1/messages" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 120
$u = ($r.Content | ConvertFrom-Json).meta.usage
Write-Host "    calls=$($u.calls)  retries=$($u.retries)  prompt=$($u.promptTokens)  completion=$($u.completionTokens)"
Write-Host "    costCny=$($u.costCny)" -ForegroundColor DarkGray

Write-Host ''
Write-Host '=== 2. 改口：先说六千，后说七千多' -ForegroundColor Cyan
Reset-Conv 'rb-conflict'
$r1 = Invoke-WebRequest -Uri "$Base/api/v1/messages" -Method POST -Body (New-Body 'rb-conflict' 'c1' '一个月六千就行') -ContentType 'application/json' -UseBasicParsing -TimeoutSec 120
$r2 = Invoke-WebRequest -Uri "$Base/api/v1/messages" -Method POST -Body (New-Body 'rb-conflict' 'c2' '不过得七千多我才去') -ContentType 'application/json' -UseBasicParsing -TimeoutSec 120
$res2 = $r2.Content | ConvertFrom-Json
$conflict = $res2.trace | Where-Object { $_.node -eq 'conflict' }
Write-Host "    conflict trace: $($conflict.detail)" -ForegroundColor Yellow
$text2 = ($res2.actions | Where-Object { $_.type -eq 'text' }).text
Write-Host "    action=$($res2.meta.action)  decision=$($res2.meta.match.decision)"
Write-Host "    A: $($text2 -replace "`n", ' / ')"

Write-Host ''
Write-Host '=== 3. 并发：同一会话同时打 5 条相同 messageId' -ForegroundColor Cyan
Reset-Conv 'rb-race'
$sameBody = New-Body 'rb-race' 'race-1' '还招人吗'
$same = 1..5 | ForEach-Object -Parallel {
  $b = $using:sameBody; $base = $using:Base
  try {
    $r = Invoke-WebRequest -Uri "$base/api/v1/messages" -Method POST -Body $b -ContentType 'application/json' -UseBasicParsing -TimeoutSec 120
    $j = $r.Content | ConvertFrom-Json
    [pscustomobject]@{ Trace = $j.traceId; Cached = $j.meta.cached; Status = 200 }
  } catch {
    [pscustomobject]@{ Trace = 'ERR'; Cached = $false; Status = [int]$_.Exception.Response.StatusCode }
  }
}

$traces = $same | Select-Object -ExpandProperty Trace -Unique
$cached = ($same | Where-Object { $_.Cached }).Count
Write-Host "    唯一 traceId 数 = $($traces.Count)（应为 1）"
Write-Host "    命中幂等 = $cached / 5"
if ($traces.Count -ne 1) { throw "并发下同一 messageId 被处理了多次" }

Write-Host ''
Write-Host '=== 4. 并发：同一会话 4 条不同的消息' -ForegroundColor Cyan
Reset-Conv 'rb-race2'
$bodies = 1..4 | ForEach-Object { New-Body 'rb-race2' "race2-$_" '还招人吗' }
$res = $bodies | ForEach-Object -Parallel {
  $b = $_ ; $base = $using:Base
  try {
    $r = Invoke-WebRequest -Uri "$base/api/v1/messages" -Method POST -Body $b -ContentType 'application/json' -UseBasicParsing -TimeoutSec 120
    (($r.Content | ConvertFrom-Json).meta.latencyMs)
  } catch { -1 }
}
Write-Host "    各自 latencyMs: $($res -join ', ')"
Write-Host "    全部成功 = $(($res | Where-Object { $_ -gt 0 }).Count -eq 4)"

Write-Host ''
Write-Host 'DONE' -ForegroundColor Cyan

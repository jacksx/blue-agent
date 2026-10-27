# 连发合并：三条消息只回一次，且重发同一批不会重复处理
# 用法： pwsh -File scripts/merge-check.ps1

param([string]$Base = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'

# 每次跑用独立会话和 messageId：否则上一轮的幂等缓存会让"首次处理"看起来像重放
$script:run = ([guid]::NewGuid().ToString('N')).Substring(0, 8)

function Post-Turn {
  param($Body)

  $json = $Body | ConvertTo-Json -Depth 20 -Compress
  try {
    $r = Invoke-WebRequest -Uri "$Base/api/v1/messages" -Method POST -Body $json -ContentType 'application/json' -UseBasicParsing
    return [pscustomobject]@{ Status = $r.StatusCode; Res = ($r.Content | ConvertFrom-Json); Mixed = $false }
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    if ($code -ne 409) { throw }
  }

  # 补快照重发同一批（幂等键不变）
  $m = Invoke-RestMethod "$Base/api/mock/subject?job=job-a&candidate=cand-zhangwei&full=1"
  $Body.subject.candidate['snapshot'] = $m.candidate
  $Body.subject.jobOrder['snapshot'] = $m.job
  $json2 = $Body | ConvertTo-Json -Depth 30 -Compress
  $r2 = Invoke-WebRequest -Uri "$Base/api/v1/messages" -Method POST -Body $json2 -ContentType 'application/json' -UseBasicParsing
  return [pscustomobject]@{ Status = $r2.StatusCode; Res = ($r2.Content | ConvertFrom-Json); Mixed = $true }
}

function New-Body {
  param([string]$Conv, [array]$Texts)
  $now = (Get-Date).ToUniversalTime()
  $msgs = @()
  for ($i = 0; $i -lt $Texts.Count; $i++) {
    $msgs += @{
      messageId = "p$i-$($script:run)"
      type      = 'text'
      text      = $Texts[$i]
      sentAt    = $now.AddSeconds($i).ToString('o')
    }
  }
  return @{
    platform       = 'boss'
    conversationId = $Conv
    messages       = $msgs
    subject        = @{
      candidate = @{ id = 'cand-zhangwei'; version = '2026-10-22T09:00:00+08:00' }
      jobOrder  = @{ id = 'job-a'; version = '2026-10-22T09:00:00+08:00' }
    }
  }
}

function Show {
  param([string]$Title, $Out)
  $res = $Out.Res
  $text = ($res.actions | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
  Write-Host ''
  Write-Host "=== $Title" -ForegroundColor Cyan
  Write-Host "    traceId=$($res.traceId)  cached=$($res.meta.cached)  mergedFrom=$($res.meta.mergedFrom -join ',')"
  Write-Host "    TEXT: $($text -replace "`n", ' / ')" -ForegroundColor Green
  Write-Host "    意图: $($res.meta.intent -join ',')" -ForegroundColor DarkGray
}

# 1. 连发三条：只回一次
$b1 = New-Body "mc1-$($script:run)" @('还招人吗', '多少钱一个月', '包吃住吗')
Show '连发三条（还招人吗 / 多少钱 / 包吃住）' (Post-Turn -Body $b1)

# 2. 同样三条，换顺序重发：幂等键应当一致，不重复处理
$b2 = New-Body "mc1-$($script:run)" @('还招人吗', '多少钱一个月', '包吃住吗')
$b2.messages = @($b2.messages[2], $b2.messages[0], $b2.messages[1])
$out2 = Post-Turn -Body $b2
Write-Host ''
Write-Host '=== 打乱顺序重发同一批 → 应该命中幂等' -ForegroundColor Cyan
Write-Host "    cached=$($out2.Res.meta.cached)  traceId=$($out2.Res.traceId)" -ForegroundColor Green

# 3. 只有一条时不合并，行为跟以前一致
$b3 = New-Body "mc2-$($script:run)" @('还招人吗')
Show '单条（不触发合并）' (Post-Turn -Body $b3)

# 收尾：别把测试会话留在演示数据里
foreach ($conv in @("mc1-$($script:run)", "mc2-$($script:run)")) {
  Invoke-WebRequest "$Base/api/v1/messages?conversationId=$conv" -Method Delete -UseBasicParsing | Out-Null
}

Write-Host ''
Write-Host 'DONE' -ForegroundColor Cyan

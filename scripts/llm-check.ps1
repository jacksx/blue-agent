# 验证模型层：改写生效 / 接地校验拦截 / 失败降级
# 需要：mock-llm.mjs + 一个带 DEEPSEEK_* 环境变量启动的服务
#   node scripts/mock-llm.mjs
#   $env:DEEPSEEK_API_KEY='test'; $env:DEEPSEEK_BASE_URL='http://127.0.0.1:8899'; pnpm exec next start -p 3100
#   pwsh -File scripts/llm-check.ps1

param(
  [string]$Base = 'http://127.0.0.1:3100',
  [string]$Mock = 'http://127.0.0.1:8899'
)

$ErrorActionPreference = 'Stop'

function Send-Chat {
  param([string]$Text, [string]$Conv)

  $m = Invoke-RestMethod "$Base/api/mock/subject?job=job-a&candidate=cand-zhangwei"
  $b = $m.request
  $b.conversationId = $Conv
  $b.messageId = "$Conv-1"
  $b.message.text = $Text
  $b.subject.candidate | Add-Member -NotePropertyName snapshot -NotePropertyValue $m.candidate -Force
  $b.subject.jobOrder | Add-Member -NotePropertyName snapshot -NotePropertyValue $m.job -Force
  $json = $b | ConvertTo-Json -Depth 20 -Compress

  $r = Invoke-WebRequest -Uri "$Base/api/v1/messages" -Method POST -Body $json -ContentType 'application/json' -UseBasicParsing
  $res = $r.Content | ConvertFrom-Json
  $text = ($res.actions | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
  $compose = $res.trace | Where-Object { $_.node -eq 'compose' } | Select-Object -Last 1
  [pscustomobject]@{
    Text    = $text
    Model   = $res.meta.model
    Degrade = $res.meta.degraded
    Compose = $compose.detail
  }
}

function Case {
  param([string]$Mode, [string]$Label, [string]$Conv)
  Invoke-RestMethod "$Mock/mode" -Method POST -Body (@{ mode = $Mode } | ConvertTo-Json) -ContentType 'application/json' | Out-Null
  $r = Send-Chat -Text '还招人吗' -Conv $Conv
  Write-Host ''
  Write-Host "=== $Label  (mode=$Mode)" -ForegroundColor Cyan
  Write-Host "    degraded=$($r.Degrade)  model=$($r.Model)"
  Write-Host "    compose : $($r.Compose)" -ForegroundColor DarkGray
  Write-Host "    TEXT    : $($r.Text -replace "`n", ' / ')" -ForegroundColor Green
}

Case 'good' '正常改写' 'lc1'
Case 'hallucinate' '编了个 8000' 'lc2'
Case 'dropQuestion' '把问句吃了' 'lc3'
Case 'contact' '导流到微信' 'lc4'
Case 'http500' '上游 500' 'lc5'

Write-Host ''
Write-Host 'DONE' -ForegroundColor Cyan

# 冒烟脚本：按真实对话顺序跑一遍，确认"说人话 + 推进招聘"这两件事都对
# 用法： pwsh -File scripts/smoke.ps1

$base = 'http://127.0.0.1:3000'
$ErrorActionPreference = 'Stop'

# 每次跑都从干净会话开始，否则上一轮的状态会串进来
foreach ($c in 's1', 's2', 's3', 's4', 's5', 's6') {
  try {
    Invoke-WebRequest -Uri "$base/api/v1/messages?conversationId=$c" -Method DELETE -UseBasicParsing -TimeoutSec 10 | Out-Null
  } catch { }
}

function Send-Agent {
  param([string]$Candidate, [string]$Job, [string]$Text, [string]$Conv, [string]$Mid)

  $m = Invoke-RestMethod "$base/api/mock/subject?job=$Job&candidate=$Candidate"
  $b = $m.request
  $b.conversationId = $Conv
  $b.messageId = $Mid
  $b.message.text = $Text
  $json = $b | ConvertTo-Json -Depth 20 -Compress

  $wire = @()
  try {
    $r = Invoke-WebRequest -Uri "$base/api/v1/messages" -Method POST -Body $json -ContentType 'application/json' -UseBasicParsing
    $wire += "$($r.StatusCode) reference $($json.Length)B"
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    $wire += "$code reference $($json.Length)B"
    if ($code -ne 409) { throw }
    $b.subject.candidate | Add-Member -NotePropertyName snapshot -NotePropertyValue $m.candidate -Force
    $b.subject.jobOrder | Add-Member -NotePropertyName snapshot -NotePropertyValue $m.job -Force
    $json2 = $b | ConvertTo-Json -Depth 30 -Compress
    $r = Invoke-WebRequest -Uri "$base/api/v1/messages" -Method POST -Body $json2 -ContentType 'application/json' -UseBasicParsing
    $wire += "$($r.StatusCode) full $($json2.Length)B"
  }

  $res = $r.Content | ConvertFrom-Json
  return [pscustomobject]@{ Res = $res; Wire = $wire }
}

function Show {
  param([string]$Title, $Out)
  $res = $Out.Res
  Write-Host ''
  Write-Host "=== $Title" -ForegroundColor Cyan
  if ($Out.Wire.Count -gt 1) { Write-Host "    wire: $($Out.Wire -join '  ->  ')" -ForegroundColor DarkGray }
  Write-Host "    decision=$($res.meta.match.decision)  state=$($res.state)  score=$($res.meta.match.score)"
  foreach ($a in $res.actions) {
    switch ($a.type) {
      'text' { Write-Host "    TEXT : $($a.text -replace "`n", ' / ')" -ForegroundColor Green }
      'job_cards' {
        $titles = ($a.jobs | ForEach-Object { $_.title }) -join ' / '
        Write-Host "    CARDS: $titles" -ForegroundColor Yellow
      }
      'interview_form' { Write-Host "    FORM : $($a.prefill.'岗位')" -ForegroundColor Magenta }
      'handoff' { Write-Host "    HANDOFF: $($a.summary)" -ForegroundColor Red }
    }
  }
}

Write-Host ''
Write-Host '──── 张伟 × 电子厂：问 → 问班次 → 问他来不来 → 才发采集表 ────' -ForegroundColor White

Show '张伟 A 还招人吗' (Send-Agent 'cand-zhangwei' 'job-a' '还招人吗' 's1' 'm1')
Show '张伟 A 能接受' (Send-Agent 'cand-zhangwei' 'job-a' '能接受' 's1' 'm2')
Show '张伟 A 可以' (Send-Agent 'cand-zhangwei' 'job-a' '可以' 's1' 'm3')

Write-Host ''
Write-Host '──── 李桂芳 × 包装厂：条件全对，直接表达意向，不甩表 ────' -ForegroundColor White

Show '李桂芳 B 还招人吗' (Send-Agent 'cand-liguifang' 'job-b' '还招人吗' 's2' 'm4')
Show '李桂芳 B 可以' (Send-Agent 'cand-liguifang' 'job-b' '可以' 's2' 'm5')

Write-Host ''
Write-Host '──── 王强 × 电子厂：先问班次，再谈薪资，不推卡 ────' -ForegroundColor White

Show '王强 A 还招人吗' (Send-Agent 'cand-wangqiang' 'job-a' '还招人吗' 's3' 'm6')
Show '王强 A 能接受（班次）' (Send-Agent 'cand-wangqiang' 'job-a' '能接受' 's3' 'm7')
Show '王强 A 能接受（薪资）' (Send-Agent 'cand-wangqiang' 'job-a' '能接受' 's3' 'm8')

Write-Host ''
Write-Host '──── 王强 × 餐饮：差 14%，坦白问，还是不动推送 ────' -ForegroundColor White

Show '王强 C 还招人吗' (Send-Agent 'cand-wangqiang' 'job-c' '还招人吗' 's4' 'm9')

Write-Host ''
Write-Host '──── 硬约束：只能白班 → 这才是推卡 ────' -ForegroundColor White

Show '张伟 A 我只能上白班' (Send-Agent 'cand-zhangwei' 'job-a' '我只能上白班，要接孩子' 's5' 'm10')
Show '张伟 B 还招人吗（跨岗位沿用）' (Send-Agent 'cand-zhangwei' 'job-b' '还招人吗' 's5' 'm11')

Write-Host ''
Write-Host '──── 红线与稳态 ────' -ForegroundColor White

Show '张伟 A 加个微信吧' (Send-Agent 'cand-zhangwei' 'job-a' '加个微信吧' 's6' 'm12')
Show '重发 m1（幂等重放）' (Send-Agent 'cand-zhangwei' 'job-a' '还招人吗' 's1' 'm1')

Write-Host ''
Write-Host 'DONE' -ForegroundColor Cyan

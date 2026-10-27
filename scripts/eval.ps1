# 回归集：改了判定或 prompt 之后先跑这个
# 用法：
#   pwsh -File scripts/eval.ps1                 # 每条 1 次（规则版够用）
#   pwsh -File scripts/eval.ps1 -Runs 3         # 每条 3 次取多数票（接模型后建议）
#   pwsh -File scripts/eval.ps1 -SaveBaseline   # 把本次结果存成基线（改之前跑）
#
# 判读顺序：先看 broken（有没有弄坏），再看 fixed 和 McNemar，最后才看总分。

param(
  [string]$Base = 'http://127.0.0.1:3000',
  [int]$Runs = 1,
  [switch]$SaveBaseline,
  [switch]$NoBaseline
)

$ErrorActionPreference = 'Stop'

$qs = "runs=$Runs"
if ($SaveBaseline) { $qs += '&saveBaseline=1' }
if ($NoBaseline) { $qs += '&baseline=0' }

$r = Invoke-RestMethod "$Base/api/eval/run?$qs" -TimeoutSec 900

$model = if ($r.hasModel) { '模型已接入' } else { '纯规则（未配 key，模型专属 case 跳过）' }

Write-Host ''
Write-Host "pass $($r.passed)/$($r.ran)  ($($r.passRate)%)   skipped $($r.skipped)   degraded $($r.degraded)   flaky $($r.flaky)   runs $($r.runs)   $($r.durationMs)ms   [$model]" -ForegroundColor Cyan
Write-Host "git $($r.gitSha)" -ForegroundColor DarkGray

Write-Host ''
Write-Host '  ── 分维度 ──' -ForegroundColor DarkGray
foreach ($p in $r.dimensions.PSObject.Properties) {
  $d = $p.Value
  $color = if ($d.passRate -ge 100) { 'DarkGray' } elseif ($d.passRate -ge 80) { 'Yellow' } else { 'Red' }
  Write-Host ("  {0,-12} {1,3}/{2,-3} {3,5}%   抖 {4}" -f $p.Name, $d.passed, $d.ran, $d.passRate, $d.flaky) -ForegroundColor $color
}

Write-Host ''
Write-Host '  ── case ──' -ForegroundColor DarkGray
foreach ($c in $r.cases) {
  if ($c.skipped) {
    Write-Host ("  SKIP  {0,-34} {1}" -f $c.id, $c.desc) -ForegroundColor DarkGray
  } elseif ($c.ok) {
    $tag = if ($c.flaky) { "  (抖 $($c.passCount)/$($c.runs))" } else { '' }
    Write-Host ("  PASS  {0,-34} {1}{2}" -f $c.id, $c.desc, $tag) -ForegroundColor DarkGray
  } else {
    Write-Host ("  FAIL  {0,-34} {1}" -f $c.id, $c.desc) -ForegroundColor Red
    foreach ($f in $c.failures) { Write-Host "        - $f" -ForegroundColor Yellow }
    Write-Host "        实际: $($c.lastText -replace "`n", ' / ')" -ForegroundColor DarkGray
  }
}

if ($r.baseline) {
  $b = $r.baseline
  Write-Host ''
  Write-Host "  ── 对比基线 $($b.savedAt) · git $($b.gitSha) ──" -ForegroundColor DarkGray
  Write-Host ("  fixed {0}   broken {1}   仍失败 {2}   配对样本 {3}" -f $b.fixed.Count, $b.broken.Count, $b.stillFail.Count, $b.compared) -ForegroundColor Cyan
  if ($b.fixed.Count -gt 0) { Write-Host "  修好: $($b.fixed -join ', ')" -ForegroundColor Green }
  if ($b.broken.Count -gt 0) { Write-Host "  弄坏: $($b.broken -join ', ')" -ForegroundColor Red }
  $m = $b.mcnemar
  $sig = if ($m.significant) { '显著' } else { '不显著' }
  Write-Host "  McNemar  b=$($m.b) c=$($m.c)  χ²=$($m.chi2)  p=$($m.pValue)  → $sig" -ForegroundColor DarkGray
}

Write-Host ''
if ($r.baselineSaved) {
  Write-Host 'BASELINE SAVED' -ForegroundColor Cyan
}
if ($r.failed -gt 0) {
  Write-Host "REGRESSION: $($r.failed) case(s) failed" -ForegroundColor Red
  exit 1
}
if ($r.baseline -and $r.baseline.broken.Count -gt 0) {
  Write-Host "REGRESSION: $($r.baseline.broken.Count) case(s) were broken vs baseline" -ForegroundColor Red
  exit 1
}
Write-Host 'ALL GREEN' -ForegroundColor Green
if ($r.skipped -gt 0) {
  Write-Host "$($r.skipped) 条模型专属 case 被跳过——填上 DEEPSEEK_API_KEY 再跑一次" -ForegroundColor DarkGray
}
if ($r.runs -lt 3 -and $r.hasModel) {
  Write-Host '接了模型建议 -Runs 3：单次结果会抖，flaky 数就是抖的证据' -ForegroundColor DarkGray
}

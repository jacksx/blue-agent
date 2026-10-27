# L1 单元级检查：纯函数、毫秒级，不调模型
# 用法： pwsh -File scripts/unit-check.ps1

param([string]$Base = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'
$r = Invoke-RestMethod "$Base/api/eval/unit" -TimeoutSec 60

Write-Host ''
Write-Host "pass $($r.passed)/$($r.total)   $($r.durationMs)ms" -ForegroundColor Cyan
Write-Host ''

foreach ($c in $r.cases) {
  if ($c.ok) {
    Write-Host ("  PASS  {0,-28} {1}" -f $c.id, $c.desc) -ForegroundColor DarkGray
  } else {
    Write-Host ("  FAIL  {0,-28} {1}" -f $c.id, $c.desc) -ForegroundColor Red
    Write-Host "        $($c.detail)" -ForegroundColor Yellow
  }
}

Write-Host ''
if ($r.failed -gt 0) {
  Write-Host "UNIT FAILURES: $($r.failed)" -ForegroundColor Red
  exit 1
}
Write-Host 'ALL GREEN' -ForegroundColor Green

# RAG 检索评测：召回 / 拒答 / 消融
# 用法： pwsh -File scripts/rag-check.ps1 [-Details]

param(
  [string]$Base = 'http://127.0.0.1:3000',
  [switch]$Details
)

$ErrorActionPreference = 'Stop'
$url = "$Base/api/eval/rag"
if ($Details) { $url += '?details=1' }
$r = Invoke-RestMethod $url -TimeoutSec 120

Write-Host ''
Write-Host "语料 $($r.corpusSize) 条 · 题集 $($r.cases) 条 · $($r.durationMs)ms" -ForegroundColor DarkGray
Write-Host ''
Write-Host ("  {0,-14} {1,8} {2,8} {3,10} {4,10}" -f 'mode', 'Recall@5', 'MRR@5', '拒答准确率', '误拒率') -ForegroundColor DarkGray
foreach ($m in $r.modes) {
  $color = if ($m.mode -eq 'hybrid+rerank') { 'Cyan' } else { 'DarkGray' }
  Write-Host ("  {0,-14} {1,8} {2,8} {3,10} {4,10}" -f $m.mode, $m.recallAt5, $m.mrrAt5, $m.refusalAccuracy, $m.falseRefusalRate) -ForegroundColor $color
}

$p = $r.primary
Write-Host ''
Write-Host "线上配置 hybrid+rerank：Recall@5 $($p.recallAt5)  MRR@5 $($p.mrrAt5)  拒答 $($p.refusalAccuracy)  误拒 $($p.falseRefusalRate)" -ForegroundColor Cyan

if ($Details) {
  Write-Host ''
  Write-Host '  ── 逐条（hybrid+rerank）──' -ForegroundColor DarkGray
  foreach ($c in $p.details) {
    $status = if ($c.hit) { 'HIT ' } else { 'MISS' }
    $color = if ($c.hit) { 'DarkGray' } else { 'Red' }
    $ids = ($c.topIds | Select-Object -First 2) -join ','
    $refusedText = if ($c.refused) { '[拒答]' } else { '' }
    $line = '  {0} {1,-26} top={2,-5} [{3}]  {4}' -f $status, $c.query, $c.topScore, $ids, $refusedText
    Write-Host $line -ForegroundColor $color
  }
}

Write-Host ''
$ok = $p.recallAt5 -ge 0.9 -and $p.refusalAccuracy -ge 0.9 -and $p.falseRefusalRate -le 0.1
if (-not $ok) {
  Write-Host 'RAG REGRESSION: 召回或拒答跌破阈值' -ForegroundColor Red
  exit 1
}
Write-Host 'ALL GREEN' -ForegroundColor Green

# TODO.md 格式与计数自检
# 用法： pwsh -File scripts/todo-check.ps1
#
# 只做"机械可判"的检查，防止文档漂移：
#   1. 每个 [x] 完成项必须带日期（YYYY-MM-DD）
#   2. 每个 [ ] 待做项必须带验收标准（以 — 分隔）
#   3. 「当前快照」里的任务计数必须与真实条目一致
#   4. 必需章节不能缺
#
# 它不判断任务是否真的做完——那是人的责任；它只保证"说做完了"这件事有格式。

param([string]$Path = 'TODO.md')

$ErrorActionPreference = 'Stop'
$script:failed = 0

function Fail($msg) {
  Write-Host "  FAIL  $msg" -ForegroundColor Red
  $script:failed++
}

function Ok($msg) {
  Write-Host "  ok    $msg" -ForegroundColor DarkGray
}

if (-not (Test-Path $Path)) {
  Write-Host "TODO.md 不存在：$Path" -ForegroundColor Red
  exit 1
}

$lines = Get-Content -LiteralPath $Path -Encoding UTF8
$raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8

Write-Host ''
Write-Host "检查 $Path" -ForegroundColor Cyan

# ── 必需章节 ────────────────────────────────────────────────
foreach ($section in @('# 任务清单', '## 维护规则', '## 当前快照', '## P0', '## P1', '## P2', '## 已完成', '## 明确不做', '## 更新日志')) {
  if ($raw.Contains($section)) { Ok "章节存在：$section" }
  else { Fail "缺少章节：$section" }
}

# ── 条目 ────────────────────────────────────────────────────
$done = @($lines | Where-Object { $_ -match '^- \[x\] ' })
$pending = @($lines | Where-Object { $_ -match '^- \[ \] ' })
$none = @($lines | Where-Object { $_ -match '^- \[-\] ' })

$missingDate = @($done | Where-Object { $_ -notmatch '20\d{2}-\d{2}-\d{2}' })
if ($missingDate.Count -eq 0) { Ok "完成项都带日期（$($done.Count) 条）" }
else {
  Fail "有 $($missingDate.Count) 条完成项缺日期（YYYY-MM-DD）"
  foreach ($d in $missingDate) { Write-Host "        $d" -ForegroundColor Yellow }
}

$missingCriteria = @($pending | Where-Object { $_ -notmatch '—' })
if ($missingCriteria.Count -eq 0) { Ok "待做项都带验收标准（$($pending.Count) 条）" }
else {
  Fail "有 $($missingCriteria.Count) 条待做项没有 — 验收标准"
  foreach ($p in $missingCriteria) { Write-Host "        $p" -ForegroundColor Yellow }
}

# ── 按章节数 P0/P1/P2 ───────────────────────────────────────
function Count-PendingInSection($startPattern, $endPattern) {
  $start = -1
  $end = $lines.Count
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($start -lt 0 -and $lines[$i] -match $startPattern) { $start = $i; continue }
    if ($start -ge 0 -and $lines[$i] -match $endPattern) { $end = $i; break }
  }
  if ($start -lt 0) { return -1 }
  return @($lines[$start..($end - 1)] | Where-Object { $_ -match '^- \[ \] ' }).Count
}

$p0 = Count-PendingInSection '^## P0' '^## P1'
$p1 = Count-PendingInSection '^## P1' '^## P2'
$p2 = Count-PendingInSection '^## P2' '^## 已完成'

# ── 快照计数 ────────────────────────────────────────────────
$countLine = @($lines | Where-Object { $_ -match '任务计数' })
if ($countLine.Count -ne 1) {
  Fail '「当前快照」里找不到唯一一行「任务计数」'
} else {
  $cl = $countLine[0]
  if ($cl -match '已完成 \*\*(\d+)\*\*.*待做 \*\*(\d+)\*\*（P0 (\d+) / P1 (\d+) / P2 (\d+)）.*明确不做 \*\*(\d+)\*\*') {
    $declaredDone = [int]$Matches[1]
    $declaredPending = [int]$Matches[2]
    $declaredP0 = [int]$Matches[3]
    $declaredP1 = [int]$Matches[4]
    $declaredP2 = [int]$Matches[5]
    $declaredNone = [int]$Matches[6]

    Ok "声明计数：done=$declaredDone pending=$declaredPending（P0 $declaredP0 / P1 $declaredP1 / P2 $declaredP2） none=$declaredNone"
    Ok "实际计数：done=$($done.Count) pending=$($pending.Count)（P0 $p0 / P1 $p1 / P2 $p2） none=$($none.Count)"

    if ($declaredDone -ne $done.Count) { Fail "已完成计数不一致：声明 $declaredDone，实际 $($done.Count)" }
    if ($declaredPending -ne $pending.Count) { Fail "待做计数不一致：声明 $declaredPending，实际 $($pending.Count)" }
    if ($declaredP0 -ne $p0) { Fail "P0 计数不一致：声明 $declaredP0，实际 $p0" }
    if ($declaredP1 -ne $p1) { Fail "P1 计数不一致：声明 $declaredP1，实际 $p1" }
    if ($declaredP2 -ne $p2) { Fail "P2 计数不一致：声明 $declaredP2，实际 $p2" }
    if ($declaredNone -ne $none.Count) { Fail "明确不做计数不一致：声明 $declaredNone，实际 $($none.Count)" }
  } else {
    Fail '任务计数行格式不对，应为：已完成 **N** · 待做 **N**（P0 N / P1 N / P2 N）· 明确不做 **N**'
  }
}

# ── AGENTS.md 与 TODO 的互相引用 ────────────────────────────
if (Test-Path 'AGENTS.md') {
  $agents = Get-Content 'AGENTS.md' -Raw -Encoding UTF8
  if ($agents.Contains('TODO.md')) { Ok 'AGENTS.md 引用了 TODO.md' }
  else { Fail 'AGENTS.md 没有引用 TODO.md' }
  if ($agents.Contains('todo-check')) { Ok 'AGENTS.md 引用了 todo-check' }
  else { Fail 'AGENTS.md 没有引用 todo-check' }
} else {
  Fail '缺少 AGENTS.md（agent 的工作区指令）'
}

Write-Host ''
if ($script:failed -gt 0) {
  Write-Host "TODO CHECK FAILED: $($script:failed) 项" -ForegroundColor Red
  exit 1
}
Write-Host 'TODO DOC OK' -ForegroundColor Green

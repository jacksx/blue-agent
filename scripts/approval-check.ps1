# 审批中断 / 恢复 验证
# 用法： pwsh -File scripts/approval-check.ps1
#
# 覆盖：
#   1. require 策略 → 发采集表前中断（PENDING_APPROVAL），此时没有任何副作用
#   2. 审批未处理时继续发新消息 → 409 PENDING_APPROVAL
#   3. resume approve → 执行提案；同一 messageId 重发 → 幂等
#   4. resume reject → 回退，不发采集表
#   5. resume edit → 用人工改过的内容发
#   6. 离线 + 高置信 → 按策略自动放行
#   7. 离线 + 阈值更高 → 等审批

param([string]$Base = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'
$script:failed = 0

function Assert($cond, $msg) {
  if ($cond) {
    Write-Host "  ok    $msg" -ForegroundColor DarkGray
  } else {
    Write-Host "  FAIL  $msg" -ForegroundColor Red
    $script:failed++
  }
}

function PostJson($body) {
  $json = $body | ConvertTo-Json -Depth 20 -Compress
  $r = Invoke-WebRequest "$Base/api/v1/messages" -Method Post -ContentType 'application/json' -Body $json -SkipHttpErrorCheck
  return [pscustomobject]@{ status = [int]$r.StatusCode; body = ($r.Content | ConvertFrom-Json) }
}

function ResetConv($conv) {
  Invoke-WebRequest "$Base/api/v1/messages?conversationId=$conv" -Method Delete | Out-Null
}

function NewCtx($conv, $online = $true, $threshold = $null) {
  ResetConv $conv
  $sub = Invoke-RestMethod "$Base/api/mock/subject?job=job-a&candidate=cand-zhangwei&full=1"
  $policy = @{ default = 'auto'; overrides = @{ interview_form = 'require' } }
  if ($null -ne $threshold) { $policy.confidenceThreshold = $threshold }
  return @{ conv = $conv; job = $sub.job; cand = $sub.candidate; online = $online; policy = $policy }
}

function Send($ctx, $text, $mid) {
  $body = @{
    messageId = $mid
    platform = 'boss'
    conversationId = $ctx.conv
    message = @{ type = 'text'; text = $text; sentAt = (Get-Date).ToString('o') }
    subject = @{
      candidate = @{ id = $ctx.cand.id; version = $ctx.cand.updatedAt; snapshot = $ctx.cand }
      jobOrder = @{ id = $ctx.job.id; version = $ctx.job.updatedAt; snapshot = $ctx.job }
    }
    recruiter = @{ id = $ctx.job.recruiter.id; online = $ctx.online }
    approvalPolicy = $ctx.policy
  }
  return PostJson $body
}

function SendResume($ctx, $approvalId, $decision, $mid, $edited = $null, $note = '') {
  $body = @{
    messageId = $mid
    platform = 'boss'
    conversationId = $ctx.conv
    resume = @{ approvalId = $approvalId; decision = $decision; note = $note }
  }
  if ($null -ne $edited) { $body.resume.editedActions = $edited }
  return PostJson $body
}

function WaitApproval($ctx, $prefix) {
  $null = Send $ctx '还招人吗' "$prefix-1"
  $null = Send $ctx '能接受' "$prefix-2"
  return Send $ctx '可以' "$prefix-3"
}

Write-Host ''
Write-Host '── 1. 中断：采集表发出去之前停下来 ──' -ForegroundColor Cyan
$c1 = NewCtx 'conv-approval-check-1'
$r3 = WaitApproval $c1 'a1'
$apr = $r3.body.actions | Where-Object { $_.type -eq 'approval_request' }
Assert ($r3.status -eq 200) "请求成功（$($r3.status)）"
Assert ($r3.body.state -eq 'PENDING_APPROVAL') "状态是 PENDING_APPROVAL（$($r3.body.state)）"
Assert ($null -ne $apr) '返回 approval_request'
Assert (($r3.body.actions | Where-Object { $_.type -eq 'interview_form' }) -eq $null) '此刻没有真的发采集表'
Assert ($apr.proposed.type -contains 'interview_form') 'proposed 里才有采集表'
Assert ($r3.body.meta.approval.status -eq 'requested') "meta.approval.status=requested（$($r3.body.meta.approval.status)）"

Write-Host ''
Write-Host '── 2. 审批没处理，不能继续往前走 ──' -ForegroundColor Cyan
$guard = Send $c1 '再问一句宿舍' 'a1-guard'
Assert ($guard.status -eq 409) "新消息被挡（$($guard.status)）"
Assert ($guard.body.error -eq 'PENDING_APPROVAL') "错误码 PENDING_APPROVAL（$($guard.body.error)）"

Write-Host ''
Write-Host '── 3. resume approve：执行提案，且幂等 ──' -ForegroundColor Cyan
$ok = SendResume $c1 $apr.approvalId 'approve' 'a1-resume'
$form = $ok.body.actions | Where-Object { $_.type -eq 'interview_form' }
Assert ($ok.status -eq 200) "恢复成功（$($ok.status)）"
Assert ($ok.body.state -eq 'FORM_SENT') "状态 FORM_SENT（$($ok.body.state)）"
Assert ($null -ne $form) '采集表被执行'
Assert ($form.formId -eq ($apr.proposed | Where-Object { $_.type -eq 'interview_form' }).formId) 'formId 与提案一致（没有重复建表）'
Assert ($ok.body.meta.approval.status -eq 'approved') "meta.approval.status=approved（$($ok.body.meta.approval.status)）"

$replay = SendResume $c1 $apr.approvalId 'approve' 'a1-resume'
Assert ($replay.body.meta.cached -eq $true) '同一 messageId 重发命中幂等（cached=true）'

$again = SendResume $c1 $apr.approvalId 'approve' 'a1-resume-2'
Assert ($again.status -eq 409) "换 messageId 再批一次被拒（$($again.status)）"
Assert ($again.body.error -eq 'APPROVAL_RESOLVED') "错误码 APPROVAL_RESOLVED（$($again.body.error)）"

Write-Host ''
Write-Host '── 4. resume reject：回退，不发 ──' -ForegroundColor Cyan
$c2 = NewCtx 'conv-approval-check-2'
$r2 = WaitApproval $c2 'b1'
$apr2 = $r2.body.actions | Where-Object { $_.type -eq 'approval_request' }
$rej = SendResume $c2 $apr2.approvalId 'reject' 'b1-resume' $null '资格不够，先不发'
Assert ($rej.status -eq 200) "驳回成功（$($rej.status)）"
Assert ($rej.body.state -eq 'CONFIRMING') "回退到 CONFIRMING（$($rej.body.state)）"
Assert (($rej.body.actions | Where-Object { $_.type -eq 'interview_form' }) -eq $null) '没有采集表'
Assert ($rej.body.meta.approval.status -eq 'rejected') "meta.approval.status=rejected（$($rej.body.meta.approval.status)）"

Write-Host ''
Write-Host '── 5. resume edit：人工改过再发 ──' -ForegroundColor Cyan
$c3 = NewCtx 'conv-approval-check-3'
$r3b = WaitApproval $c3 'c1'
$apr3 = $r3b.body.actions | Where-Object { $_.type -eq 'approval_request' }
$form3 = $apr3.proposed | Where-Object { $_.type -eq 'interview_form' }
$edited = @(
  @{ type = 'text'; text = 'HR 改过：明天上午 10 点直接到厂，到了打驻厂电话。' },
  $form3
)
$edit = SendResume $c3 $apr3.approvalId 'edit' 'c1-resume' $edited
$editText = ($edit.body.actions | Where-Object { $_.type -eq 'text' }).text
Assert ($edit.status -eq 200) "编辑后发送成功（$($edit.status)）"
Assert ($editText -like 'HR 改过*') "文本是人工改过的那句（$editText）"
Assert ($edit.body.meta.approval.status -eq 'edited') "meta.approval.status=edited（$($edit.body.meta.approval.status)）"
Assert (($edit.body.actions | Where-Object { $_.type -eq 'interview_form' }) -ne $null) '采集表仍然执行'

Write-Host ''
Write-Host '── 6. 离线 + 高置信 → 自动放行 ──' -ForegroundColor Cyan
$c4 = NewCtx 'conv-approval-check-4' $false
$r4 = WaitApproval $c4 'd1'
Assert ($r4.body.state -eq 'FORM_SENT') "离线高置信直接发（$($r4.body.state)）"
Assert (($r4.body.actions | Where-Object { $_.type -eq 'interview_form' }) -ne $null) '采集表已发'
Assert ($null -eq $r4.body.meta.approval) '没有审批卡'

Write-Host ''
Write-Host '── 7. 离线 + 置信阈值 1.0 → 等审批 ──' -ForegroundColor Cyan
$c5 = NewCtx 'conv-approval-check-5' $false 1.0
$r5 = WaitApproval $c5 'e1'
Assert ($r5.body.state -eq 'PENDING_APPROVAL') "阈值更高时等审批（$($r5.body.state)）"
Assert (($r5.body.actions | Where-Object { $_.type -eq 'approval_request' }) -ne $null) '返回审批卡'

foreach ($c in @($c1, $c2, $c3, $c4, $c5)) { ResetConv $c.conv }

Write-Host ''
if ($script:failed -gt 0) {
  Write-Host "APPROVAL FAILURES: $script:failed" -ForegroundColor Red
  exit 1
}
Write-Host 'ALL GREEN' -ForegroundColor Green

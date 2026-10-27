# 招聘 IM Agent（蓝领 C 端 IM 接待）

业务后端把用户消息丢进来，它还回「该说什么 + 该做什么动作」。

> 边界：**约面采集表发出即结束**。到面、入职、佣金不在范围内。

---

## 快速开始

```bash
pnpm install
pnpm dev
# 打开 http://localhost:3000
```

不填 API Key 也能跑：规则版编排 + fixture 数据 + 本地 RAG + 审批 + 评测全部可用。
填了 `DEEPSEEK_API_KEY` 之后，理解层和措辞层各调一次模型；没填就完全走规则，
行为、延迟、字节数一致。

```bash
cp .env.example .env.local   # 填 DEEPSEEK_API_KEY
pnpm dev
```

跑一遍全部链路：

| 命令 | 查什么 | 现在的实测 |
|---|---|---|
| `pwsh -File scripts/smoke.ps1` | 11 段真实对话，看话术和状态 | 全流程可走 |
| `pwsh -File scripts/eval.ps1` | 23 条回归 case，单次采样 | 23/23 |
| `pwsh -File scripts/eval.ps1 -Runs 3` | 每条 3 次取多数票，看抖不抖 | 23/23，flaky 0，degraded 0 |
| `pwsh -File scripts/eval.ps1 -SaveBaseline` | 把本次存成基线，之后跑出 fixed/broken | 见「评测」 |
| `pwsh -File scripts/approval-check.ps1` | 审批中断 / 恢复 / 驳回 / 改后发 / 离线降级 | 全绿 |
| `pwsh -File scripts/rag-check.ps1 -Details` | RAG 召回、拒答、消融 | Recall@5 1.0，拒答 1.0 |
| `pwsh -File scripts/unit-check.ps1` | 纯函数 L1（McNemar/TTL/审批/标签/接地/卡片/scope） | 33/33 |
| `pwsh -File scripts/merge-check.ps1` | 连发合并 + 顺序无关幂等 | 三条 → 一条回复 |
| `pwsh -File scripts/robust-check.ps1` | 用量 / 改口 / 并发 | 5 并发只有 1 个 traceId |

---

## 这版补完了什么

之前 README 列的「还没做」里，有四项这次做完了：

| 能力 | 落地位置 | 怎么验的 |
|---|---|---|
| **审批中断 / 恢复** | `lib/agent/approval.ts` + `POST /v1/messages` 的 `resume` | `approval-check.ps1` 全绿 |
| **RAG 答疑** | `lib/rag/*` + 编排层 policy 工具 | `rag-check.ps1` + 2 条回归 case |
| **pass@k / McNemar** | `lib/eval/stats.ts` + `/api/eval/run?runs=3` | 3 次采样 23/23，p 值与 fixed/broken |
| **标签归一化（代码层）** | `lib/agent/tags.ts` | `unit-check.ps1` 7 条标签断言 |

同时修了两个和规划不一致的暗坑：

- **跨平台岗位卡串 id**：卡片原来写死 `platformJobId.boss`，店长直聘会话里点不开。
  现在按请求的 `platform` 映射，并在卡上标来源和归属顾问。
- **用户要微信被硬拒**：规划里「用户发起换微信」是合规的转出，不是站外导流。
  现在给指路 + 交接摘要 + `TRANSFERRED`，agent 仍然永远不报自己的微信号。

还补了：槽位时效（fresh/stale/expired）、连续 2 条非文本转人工、确定性 formId。

---

## 屏幕上是四块

| 区域 | 角色 | 看什么 |
|---|---|---|
| ① 用户手机 | 模拟 BOSS 直聘 IM | 用户看到的消息、岗位卡片、采集表、审批卡 |
| ② 会话列表 | 经纪人同时在聊的多个蓝领 | 谁的会话到哪一步了（含「待审批 / 已转微信」） |
| ③ 聊天 | 经纪人视角的同一个会话 | agent 代发的回复；右上角可切 `auto / 采集表需审批` |
| ④ 用户与职位 | 判断依据 | 硬条件、可谈项、**待确认**、decision |
| ⑤ 服务视角（底部抽屉） | 业务端看到的东西 | Request / Response / Trace（含 `rag`、`approval` 节点） |

「待确认」这一栏是关键：它列出**判断还缺什么**。非空就不发采集表——表是收集信息的，不是替代判断的。

审批卡是这一版新加的：命中审批点时会停在手机里，显示「给谁发什么 + 为什么 + 草稿」，
经纪人可以**通过 / 改一句 / 驳回**。通过之前，一个副作用都没有发生。

---

## 演示脚本

左上角切换三个候选人，A/B/C 切换三个岗位。**同一岗位对不同人判定不同**，这是重点。

| # | 操作 | 应该看到 |
|---|---|---|
| 1 | 张伟 × `A·电子厂` → 「还招人吗」 | `你好，还招人的` / `我们这边是两班倒，08:00 到 20:00，你能接受吗？`。**不报价、不推卡** |
| 2 | 「能接受」 | `行。` / `这个岗位跟你挺合适的（包住、交社保）。健康证入职前能补上就行。要不要来面试？` |
| 3 | 「可以」 | `好，那就这么定` + 采集表。岗位名是「普工/操作工」，不是标题里的「280一天」 |
| 4 | 李桂芳 × `B·包装厂` → 「还招人吗」 | 条件全对 → 直接表达意向、问面试，**不甩表** |
| 5 | 王强 × `A·电子厂` → 「还招人吗」 | 先问班次（硬门槛），**不是**先谈薪资 |
| 6 | 「能接受」 | 再谈薪资：`我们这边综合是 5000 到 6500，比你想的低一点…`。**不推卡** |
| 7 | 王强 × `C·餐饮` → 「还招人吗」 | 差 14% → `跟你想的 7000 差得有点多`，坦白问。**还是不推卡** |
| 8 | 张伟 × `A` → 「我只能上白班，要接孩子」 | 硬约束 → `not_match` → 推 B、C 两张卡 |
| 9 | 紧接着切 `B·包装厂` → 「还招人吗」 | `按你之前说的只上白班，这个岗位跟你挺合适的…`（跨岗位沿用，不重问） |
| 10 | 任意 → 「加个微信吧」 | 指路「换微信」按钮 + 转人工，附交接摘要；**不报微信号** |
| 11 | 任意 → 「体检费谁出」 | `入职体检费一般 50 元左右，上班满一个月随工资报销`（RAG，不编） |
| 12 | 右上角切「采集表需审批」，走完 1→3 | 停在一张**待审批**卡上；点「通过并发送」才出采集表 |
| 13 | 拉开底部抽屉切 `request` | 稳态 325 B（只有 id + version）；每个新会话第一条 409 一次再补 2.5 KB |

---

## 写进代码的产品判断

**1. 回复长度 = 问题长度**

用户问「还招人吗」，就只回「还招人的」，外加**一个**推进动作。不主动报价——他没问的，塞进来就是噪音。

三段式：打招呼（仅首条）→ 回答他问的那一句 → 一个推进动作。

**2. 推进是有顺序的**

```
硬条件否决 → 推卡
缺判断依据 → 问第一个（班次这类硬门槛优先于薪资）
可谈项有差距 → 问一次（不推卡）
全都对得上 → 表达意向，问「要不要来面试？」
他说可以 → 才发采集表
```

之前的错是最后两步并成一步："还招人吗"直接糊一张表。现在**问一句、他答应、再发**。

**3. 岗位是用户自己点进来的，别赶人走**

薪资差 5%、8%、14%，都只是**问一句**，不是换岗。只有**用户自己提的硬约束被违反**（说只能上白班，岗位是两班倒）才推卡。所以 `NegotiableCheck` 有个 `hard` 标记，只有班次冲突会被置为 `true`。

**4. 薪资比的是上限，不是下限**

```ts
// ❌ 这么写，区间越宽的岗位越容易被误杀
const gap = (target - job.pay.displayMin) / target;   // 6000 vs 5000 → 16.7% → 直接判死

// ✅ 这么写
期望 ≤ 下限        → 满足，还能说"比你想的高"
下限 < 期望 ≤ 上限 → 满足，但注明"想拿到 6000 得配合加班"
期望 > 上限        → 才按 5% / 10% 算差距
```

顺带一条：用户说过"这个数我能接受"，那个数就是**底线**（`pref.salaryFloor`），不再是简历里的期望。

**5. 判断依据不齐，不许发采集表**

`MatchAssessment.openQuestions` 列的是"简历给不了、只能问"的东西（班次意愿、薪资预期）。健康证不在里面——**它的答案不改变任何结论**。

跨岗位时他之前说过的约束直接沿用，并在话里点明一句（`按你之前说的只上白班，…`）。重复问已经答过的事最伤"像个人"。

**6. 政策问题才走向量，岗位事实一律查库**

薪资、班次、地址在结构化字段里，查库比检索准，也不会在 chunk 之间漂移。
只有「归不了类 / 模型自认没听懂 / 命中政策域词」才进 RAG，且**低于阈值必须拒答**。

**7. 审批按副作用分级，离线不等于全放开**

发错一句文案无所谓，发错采集表用户白跑。所以策略挂在动作上：
`interview_form` 可以配 `require`，文本永远不会被卡。
经纪人离线时没人兜底，只让证据完整度 ≥ 0.85 的自动走。

**8. 过期不是丢弃，是降级**

90 天前的「只能白班」降为 stale：可以用，但引用时要暴露时间；
30 天前的薪资期望降为 expired：视为未知，必须重问。
最糟的不是用旧信息，是**静默地**用旧信息。

---

## 模型层：事实归规则，措辞归模型

一条消息走五段，模型只出现在两头：

```
合并 merge → 工具 tools → 理解 nlu → 决策 handle → 措辞 compose → 审批 approval
 纯函数      查库/RAG      模型/规则    纯同步可复现   模型+接地校验     纯函数
```

| 段 | 谁干 | 兜底 |
|---|---|---|
| 意图 | 模型输出 `topics` + `action`，两者都过 schema | 超时/非法 JSON/未知值 → 规则 |
| 决策 | 纯同步函数，不碰网络 | 无需兜底（可复现） |
| 措辞 | 模型把草稿说得像人话 | 数字/问句/联系方式越界 → 用草稿 |
| 审批 | 纯函数，按动作和证据完整度 | 不需要模型参与 |

**一条消息最先被拆成两样东西**：

```jsonc
{ "action": "ask",  "topics": ["salary", "meal", "dorm"] }   // 多少钱 包吃住吗
{ "action": "want_other", "topics": ["other"] }              // 还有别的吗
```

- `topics` = 在问什么，对应字段组，**可扩展**。加一个只加答案，不动流程。
- `action` = 想干什么，**封闭枚举**（ask / want_other / reject / accept / none），因为它出现在 `if` 里。

**决策不进模型**是故意的：它得能被回归集锁死，也得能在面试里被人问"你为什么判他不匹配"时有唯一答案。

模型**只看到草稿**——看不到岗位、简历、薪资结构。给它越少，它能编的越少。

改完还要过接地校验（`lib/llm/grounding.ts`）：

1. **数字闭包** —— 输出里的数字必须都在草稿里出现过（`08:00` 和 `8:00` 归一化后等价）
2. **问句保留** —— 草稿在提问，输出就得还在提问
3. **站外导流** —— 草稿没提微信，输出不许提
4. **承诺词** —— 草稿没有「包吃 / 交社保 / 还招」这些承诺，改写不许加

任何一条不过：丢弃改写、用回草稿、`meta.degraded = true`，trace 里写清是哪条拦的。

---

## 契约里的四个协议

### 连发合并：三条消息只回一次

用户在手机上打字慢，"还招人吗"经常拆成三条发：

```
还招人吗
多少钱一个月
包吃住吗
```

一条一处理的话，agent 会连回三次，而且三次各自触发一次判定——最坏情况**同时发出两张采集表**。

合并放在**业务端**做（静默窗口 1.2s），agent 收合并后的 turn：

```jsonc
"messages": [
  { "messageId": "p0", "type": "text", "text": "还招人吗",     "sentAt": "..." },
  { "messageId": "p1", "type": "text", "text": "多少钱一个月", "sentAt": "..." },
  { "messageId": "p2", "type": "text", "text": "包吃住吗",     "sentAt": "..." }
]
```

幂等键 = **排序后**的 messageId 集合哈希，所以三条一起重发、打乱顺序重发，都只处理一次：

```
连发三条 → 一条回复，topics = hiring,salary,dorm,meal
打乱顺序重发 → cached=True，traceId 与第一次相同
```

### 快照：只传引用，不传业务事实

```jsonc
{
  "messageId": "boss:1759...",
  "conversationId": "conv-cand-zhangwei",
  "subject": {
    "candidate": { "id": "cand-zhangwei", "version": "2026-10-22T09:00:00+08:00" },
    "jobOrder":  { "id": "job-a",        "version": "2026-10-22T09:00:00+08:00" }
  }
}
```

稳态 **325 B**，一个业务字段都没有。缓存未命中返回：

```json
409 { "error": "SNAPSHOT_REQUIRED", "missing": ["candidate", "jobOrder"] }
```

业务端带上 `snapshot` 重发同一个 `messageId` 即可（**幂等，不会重复处理**）。

### 幂等：`messageId` 是去重键

补发快照、网络重试、客户端抖动——都会用同一个 `messageId` 再打一次。没有这层，用户会收到两条一样的回复，或者更糟：**两张采集表**。

重放命中时 `meta.cached = true`，响应头带 `x-idempotent-replay: 1`，`traceId` 和第一次完全相同。

### 审批：中断 + 恢复，不是"模式"

策略按**动作**配，不是一个全局开关：

```jsonc
// 请求里可带；不传＝全自动（保持 demo 默认）
"approvalPolicy": {
  "default": "auto",
  "overrides": { "interview_form": "require" },   // 也支持 0.9 这种灰度比例
  "offlineFallback": "auto_if_confident",
  "confidenceThreshold": 0.85
}
```

命中审批点返回：

```jsonc
{
  "actions": [{
    "type": "approval_request",
    "approvalId": "apr-...",
    "proposed": [ { "type": "text", "text": "..." }, { "type": "interview_form", ... } ],
    "summary": "给 张伟 发面试采集表（普工/操作工）",
    "reason": "interview_form 配了 require"
  }],
  "state": "PENDING_APPROVAL",
  "meta": { "approval": { "status": "requested", "confidence": 0.99 } }
}
```

人工处理完，用**新的 messageId** 恢复：

```jsonc
{
  "messageId": "boss:1760...",
  "conversationId": "conv-cand-zhangwei",
  "resume": {
    "approvalId": "apr-...",
    "decision": "approve",          // approve | edit | reject
    "editedActions": [ ... ]        // decision=edit 时给
  }
}
```

四个容易写错的地方，这里都处理了：

1. **恢复不重跑判定**。中断前只算"该说什么"，没有副作用；恢复直接执行存下来的提案。
2. **formId 是确定性的**（会话 + 岗位 + 轮次），恢复多少次都是同一张表，不会重复建。
3. **审批没处理时不许继续发消息**，返回 `409 PENDING_APPROVAL`，避免状态漂移。
4. **驳回有回退点**：回到中断前的 `CONFIRMING`，不是回到 `GREETING`。

离线降级：

```
在线                      → 按 policy（interview_form: require）
离线 + 置信度 ≥ 0.85      → 自动
离线 + 置信度 < 0.85      → 等审批
offlineFallback=wait      → 一律等
```

置信度来自**证据完整度**（硬条件全过、可谈项无差距、无待确认、槽位新鲜），不是模型自评。

---

## RAG：政策答疑，低于阈值不答

### 为什么只对政策做

| 数据 | 走哪 | 为什么 |
|---|---|---|
| 岗位事实（薪资/班次/地址/名额） | 结构化字段 | 实时变化，查库比检索准 |
| 政策 / FAQ（体检费、押金、合同、离职） | RAG | 岗位单里没有，模型不能现编 |
| 岗位推荐 | 匹配函数批量应用 | 不需要检索 |

只有三类问题会触发检索：`topics` 里只有 `other`、模型自报 `unclear`、命中政策域词。
「还招人吗」「包吃住吗」这类结构化能答的，**绝不走向量**。

### 链路

```
query → 规则重写（口语→规范词）→ BM25 top20 + 本地哈希向量 top20
      → RRF 融合 → rerank（RRF + 词覆盖 + 领域匹配）→ 阈值 0.34 → 答 / 拒答
```

- 语料 27 条，按「一个可独立回答的问题」切，不按字数切。
- 向量是**本地 feature hashing**，零依赖、可复现；换 bge-m3 只改 `embed()` 一个函数。
- 拒答阈值是硬边界：宁可说「这个我帮你问一下」，也不答错一条政策。

### 实测（`scripts/rag-check.ps1`）

题集 38 条：30 条正例 + 8 条知识库外负例。

| mode | Recall@5 | MRR@5 | 拒答准确率 | 误拒率 |
|---|---|---|---|---|
| bm25 | 1.000 | 0.928 | 1.000 | 0.000 |
| vector | 1.000 | 0.911 | 1.000 | **0.267** |
| hybrid | 1.000 | 0.928 | 1.000 | 0.033 |
| **hybrid+rerank** | **1.000** | **0.928** | **1.000** | **0.000** |

诚实读法：

- 这个语料小、关键词密，**BM25 已经饱和**，所以 Recall@5 全是 1.0，看不出融合的增益。
- 能看出问题的是**向量单独用会误拒 26.7%**（哈希向量没有真正的语义，长尾词被稀释）；
  混合和 rerank 把它压回 0。这一层的价值是**稳定性**，不是涨点。
- 语料换上真实岗位/政策库后，才谈得上「混合检索比 BM25 多召回多少」。现在的数字只能证明
  链路是通的、拒答边界是有效的，不能拿去向业务证明效果。

---

## 时效与标签归一

### 槽位不是 key-value，是带属性的断言

```ts
interface Slot {
  value: unknown;
  reason?: string;              // ★ 比 value 更值钱
  strength: 'hard' | 'strong' | 'soft';
  source: 'resume' | 'chat' | 'inferred';
  evidence?: string;
  assertedAt: string;
  ttlDays?: number;
  state: 'fresh' | 'stale' | 'expired' | 'conflicted';
  carrier: 'resume' | 'chat' | 'form';
}
```

| 类型 | 半衰期 | 过期后 |
|---|---|---|
| 硬事实（年龄、现居地） | 无限 / 90 天 | 不变 |
| 强约束（只能白班 + 理由） | 90 天 | stale：可以用，引用时暴露时间 |
| 薪资期望 | 30 天 | expired：视为未知，重问 |

简历字段的 `assertedAt` 用简历自己的 `updatedAt`，不是"现在"——否则每次刷新都变新鲜，
半衰期永远不会生效。

### 标签归一化：让自定义标签可比

问题：岗位填「包吃」，用户写「管饭」，code 全不一样，比文本又不相等。

解法：加一层 canonical，**所有比对只在规范层做**。

```
内定 meal_included        → meal.provided   (1.00)
自定义「包吃」custom_8821 → meal.provided   (0.98)
自定义「管饭」custom_9932 → meal.provided   (0.98)
自定义「不包吃」custom_2  → meal.none       (0.98，否定优先)
```

置信度分流是安全边界：≥0.95 才能参与硬判断；0.8–0.95 只排序；<0.8 进 unresolved，不判死。
「管饭」被误判成「不包吃」，用户会得到一个错误答案而且永远不知道——所以这条必须严。

当前是**代码层字典**（`lib/agent/tags.ts`），`docs/schema.sql` 里的
`canonical_tags` / `tag_text_mappings` 还没接上回写与人工审核队列。

---

## 评测

### 怎么证明"变好了"

不是看通过率涨没涨，而是四件事：

1. **固定题集并版本化**（代码里，进 git）
2. **多维度指标**（flow / matching / memory / extraction / intent / compliance / recommend / rag）
3. **配对检验**：同一批 case 前后比，McNemar
4. **改之前先存 baseline**

```bash
pwsh -File scripts/eval.ps1 -SaveBaseline    # 改之前
# ...改 prompt / 判定...
pwsh -File scripts/eval.ps1 -Runs 3          # 改之后
```

报告会列出 `fixed` / `broken` 的具体 case id，不只看总分：

```
fixed 2   broken 1   仍失败 0   配对样本 22
McNemar  b=2 c=1  χ²=0  p=1  → 不显著
```

`b=19, c=3` 才算显著（p < 0.01）；`b=5, c=4` 等于没改。
规则版确定性高，`-Runs 3` 主要用来抓模型抖动；`flaky` 数就是抖的证据。

基线存在 `.data/eval-baseline.json`（gitignore），换机器要重新存一次。

### 回归集测什么

不追覆盖率，只锁**已经被推翻过一次的判断**：

| case | 锁住的事 |
|---|---|
| `first-turn-answers-only` | 首轮不报价、不推卡 |
| `ask-before-form` | 条件对了也要先问来不来 |
| `form-after-confirm` | 他说可以才发采集表 |
| `hard-gate-before-salary` | 两班倒没确认，不谈钱 |
| `salary-probe-no-cards` | 差 14% 只问一句，不推卡 |
| `carry-constraint-across-jobs` | 跨岗位沿用旧约束 |
| `no-nag-after-hesitate` | 问过一次没答应就不再追 |
| `salary-question-keeps-composition` | 报薪资必须带构成 |
| `chat-salary-overrides-resume` | 对话里的期望盖过简历，中文数字也算 |
| `interview-question-answered` | 问面试要给地点和带什么 |
| `policy-question-answered` | 体检费这类政策问题要走 RAG，不许装没看见 |
| `policy-refuses-offtopic` | 知识库外的必须拒答，不许硬编 |
| `unclear-gets-acknowledged` | 有诉求听不懂就承认 |
| `paraphrase-*`（4 条） | 口语理解：还要人不 / 娃放学 / 五千大几 / 太远了算了 |

当前 **23/23**：`-Runs 3` 跑完 flaky 0、degraded 0、约 186s。
`degraded` 统计有多少条最后靠**模板话术**收场（模型被拦或调用失败）——盯住它，别悄悄涨。

### 三层测试

| 层 | 入口 | 判据 | 耗时 |
|---|---|---|---|
| L0 单元 | `scripts/unit-check.ps1` | 纯函数、确定性 | 几十 ms |
| L1 检索 | `scripts/rag-check.ps1` | Recall / 拒答 / 消融 | < 1s |
| L2 端到端 | `scripts/eval.ps1` | 多轮对话 + 模型 | 60s / 186s（×3） |
| 审批 | `scripts/approval-check.ps1` | 状态机 + 幂等 | ~20s |

---

## 已经实现的

| 模块 | 状态 |
|---|---|
| 接口契约（请求/响应/actions） | ✅ |
| **快照引用协议 + 409 补发** | ✅ |
| **messageId 幂等重放** | ✅ |
| 岗位来源一致性校验（400） | ✅ |
| **连发合并**（1.2s 静默窗口 + 顺序无关的幂等键） | ✅ |
| **topic / action 分离**（topic 可扩展、action 封闭） | ✅ |
| **理解层接模型**（schema 校验 + 规则并集兜底） | ✅ |
| 槽位抽取 + **短回答接续**（"能""不能"能接住） | ✅ |
| **会话状态持久化**（槽位跨消息、跨岗位保留） | ✅ |
| **匹配五态**（insufficient_data / not_match / negotiable / auto_match / suggest） | ✅ |
| **三档 + 5%/10% 阈值 + 试探话术** | ✅ |
| **期望 vs 底线**（`salaryTarget` / `salaryFloor`） | ✅ |
| **硬约束 vs 可谈项**（`hard` 标记决定推不推卡） | ✅ |
| **待确认问题**（`openQuestions` 挡住发表，硬门槛优先于薪资） | ✅ |
| **面试意向确认**（`CONFIRMING` → 答应了才发表） | ✅ |
| **跨岗位约束沿用**（`interviewAskedJobId` / 槽位跨岗位保留） | ✅ |
| **模型措辞层 + 接地校验**（数字闭包 / 问句 / 站外导流 / 承诺词） | ✅ |
| **无 key 自动降级到规则**（行为零差异） | ✅ |
| **薪资构成强制说明**（`salaryBrief`） | ✅ |
| **区级通勤矩阵**（3 人 × 3 岗位不共用同一个数字） | ✅ |
| 推荐五段管线（过滤 → 打分 → 多样性 → 解释） | ✅ |
| 站外导流拦截（不报微信号） | ✅ |
| **用户发起换微信 → 转出 + 交接摘要** | ✅ |
| **审批中断 / 恢复**（按动作策略、离线降级、edit、驳回） | ✅ |
| **RAG 政策答疑**（重写 / BM25 / 向量 / RRF / rerank / 拒答） | ✅ |
| **标签归一化代码层**（canonical + 置信度分流） | ✅ |
| **槽位时效**（fresh / stale / expired） | ✅ |
| **诉求作用域**（person / subject，A 的接受度不带到 B） | ✅ |
| 跨平台卡片 id 映射 + 来源/归属展示 | ✅ |
| 非文本消息降级 + 连续 2 条转人工 | ✅ |
| **回归集 23 条 + pass@k + McNemar + 基线 diff** | ✅ |
| **L0 单元检查 33 条 / RAG 消融 38 条** | ✅ |
| 建表 SQL（含审批 / 记忆 / 评测表） | ✅ `docs/schema.sql` |

### 运行时保障

| 能力 | 做法 | 怎么验的 |
|---|---|---|
| **会话持久化** | 内存 + 异步落盘（`.data/conversations.json`，200ms 合并写） | 重启服务后接着聊第 2 轮，`turns=2`、`pendingField=shift` 都还在 |
| **重试退避** | 只重试 5xx/429/超时/网络，指数退避 + 抖动，最多 3 次 | 假模型前两次返 500，第三次成功 → `usage.retries=2` |
| **同会话串行** | 按 `conversationId` 排队，进锁后再查一次幂等 | 同一 `messageId` 并发 5 次 → 只有 1 个 `traceId` |
| **在飞限流** | 全局上限 16，超了直接 429 | `MAX_INFLIGHT` 可调 |
| **改口检测** | 槽位变化记进 `slotChanges`，trace 里留一份 | 先说 6000 后说 7000 → `pref.salaryTarget 6000 → 7000` |
| **成本埋点** | 每次模型调用累加 token / 重试次数到 `meta.usage` | `calls=2 retries=0 prompt=920 completion=78` |
| **审批 pending 拦截** | 有未处理审批时新消息 409 | `approval-check.ps1` 第 2 节 |
| **审批可审计** | `meta.approval` + trace `approval` 节点 | 通过/改/驳回都有 status 与 reason |

---

## 还没做的（W5+ / 生产化）

| 模块 | 现状 | 差什么 |
|---|---|---|
| **多职位切换（§2.9）** | 会话只有一个 active job；已用 `scope: subject` 防止 A 的「能接受班次」带到 B，`person` 硬约束仍跨岗位保留 | `subject_bindings`、按 subject 分层的 `job.*` 槽位、A→B→A 横跳 |
| **Supabase / Redis** | 会话落盘；快照 / 幂等 / 审批仍在内存 | 接 Postgres + Redis，多实例一致；审批要能跨重启恢复 |
| **RAG 生产化** | 27 条政策语料 + 本地哈希向量 | 真实语料、bge-m3 向量、人工标注题集、Recall@5 达标 |
| **标签归一落库** | canonical 字典 + 置信度分流 | `tag_text_mappings` 回写、低置信人工审核队列、按归一化文本缓存 |
| **跨经纪人转介（§2.13）** | 卡片标了归属顾问 | `referral` payload：把 slots + 摘要带进新会话 |
| **MCP server** | 工具层已抽象成 `AgentTools` | 7 个 tool / 0 个 resource 的 MCP 封装 |
| **Playground 回放 / stateless** | 审批卡、策略切换、四栏 + trace 已完成 | JSONL 回放、session/stateless 切换、工具调用面板 |
| **护栏 L2** | 非文本连续 2 条、no_candidate、unclear 已能转人工 | 情绪/投诉/要求人工/敏感话题的升级信号 |
| **指标看板** | 只有脚本输出 | 首响 P95、发表率、成本、degraded 趋势 |

---

## 目录

```
app/
  page.tsx                   四栏 Playground + 底部抽屉 + 审批卡
  api/v1/messages/route.ts   ★ 业务端入口（快照 409 / 幂等 / 平台校验 / resume）
  api/mock/subject/route.ts  fixture 出口（模拟业务端取数）
  api/eval/run/route.ts      回归集（runs / baseline / McNemar）
  api/eval/unit/route.ts     L0 纯函数检查
  api/eval/rag/route.ts      RAG 消融评测
lib/
  agent/
    types.ts                 契约类型（前后端共用）
    pipeline.ts              ★ 合并 → 工具 → 理解 → 决策 → 措辞 → 审批
    orchestrator.ts          ★ 决策（纯同步，可复现）
    match.ts                 ★ 匹配五态 + 薪资三段 + 通勤分档 + 待确认
    approval.ts              ★ 审批策略 / 中断 / 恢复 / 证据完整度
    slots.ts                 槽位时效（fresh/stale/expired）
    tags.ts                  ★ 标签归一化 + 置信度分流
    cards.ts                 岗位卡（跨平台 id / 来源 / 归属）
    recommend.ts             推荐管线 + 一致性断言
    nlu.ts                   理解（模型/规则 + 兜底）
    rules.ts                 topic/action 分类 + 槽位抽取
    merge.ts                 连发合并 + 顺序无关幂等键
    compose.ts               措辞层（模型改写 + 失败降级）
    store.ts                 会话状态 + 改口历史（内存 + 落盘）
    persistence.ts           写盘（待换 Postgres）
    lock.ts / gate.ts        同会话串行 / 在飞限流
    snapshot-cache.ts        快照缓存（待换 Redis）
    idempotency.ts           messageId 去重（待换 Redis）
  rag/
    corpus.ts                政策知识库（27 条）
    retrieve.ts              ★ 重写 / BM25 / 向量 / RRF / rerank / 拒答
    eval-cases.ts            RAG 题集（30 正 + 8 负）
  llm/
    deepseek.ts              OpenAI 兼容适配器（不引 SDK）
    grounding.ts             ★ 数字闭包 / 问句 / 站外导流 / 承诺词
    schemas.ts               模型输出 zod 校验
    prompts.ts               prompt 与版本号
  eval/
    cases.ts                 23 条回归 case
    stats.ts                 ★ 多数票 + McNemar
    dimensions.ts            评测维度
  fixtures/data.ts           3 个岗位 + 3 个候选人
scripts/
  smoke.ps1                  11 段对话冒烟
  eval.ps1                   回归集（-Runs / -SaveBaseline）
  approval-check.ps1         审批中断/恢复
  rag-check.ps1              RAG 召回/拒答/消融
  unit-check.ps1             L0 纯函数
  merge-check.ps1            连发合并 + 幂等
  robust-check.ps1           用量 / 改口 / 并发
  llm-check.ps1              模型层验证
  mock-llm.mjs               本地假模型
docs/schema.sql              Supabase 建表（含审批 / 记忆 / 评测）
```

`lib/agent/*` **不 import 任何 `next/*`**。换 Fastify / 容器部署时只改 `app/api` 这层 adapter。

---

## 下一步

- **W5**：Supabase + Redis，把会话 / 快照 / 幂等 / 审批从 Map 迁走
- **W6**：多职位切换完整模型（subject bindings + 分层槽位）
- **W7**：真实 RAG 语料 + bge-m3 + 人工题集，把 Recall@5 从"小语料饱和"变成可对外报的数
- **W8**：MCP server + 回放 + stateless 模式 + 指标看板

## 接了真模型之后

填上 `DEEPSEEK_API_KEY` 再跑回归集，5 条 `requiresModel` 的 case 会从 SKIP 变成真跑：

```bash
pwsh -File scripts/eval.ps1 -Runs 3
```

它们测的是规则做不到的口语理解：

| case | 说的是 | 要判成 |
|---|---|---|
| `paraphrase-still-hiring` | 你们那边现在还要人不 | 求职意向 |
| `paraphrase-kid-pickup` | 我娃下午五点半放学得去接，晚上回不来 | 只上白班（硬约束）→ 推卡 |
| `paraphrase-pay-range` | 一个月到手能有五千大几不 | 薪资，且必须带构成 |
| `paraphrase-too-far` | 那边太远了我跑不动，算了 | 用户主动要别的岗位 |
| `unclear-gets-acknowledged` | 我媳妇也在找活儿，你们一起招吗 | 接住 + 承认听不懂的部分 |

每条消息会调两次模型（理解 1 次 + 措辞 1 次），延迟约 1.5–3s。
两个调用都有超时和兜底，模型挂了这个系统仍然能回话，只是话说得朴素一点。

'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  AgentAction,
  AgentRequest,
  AgentResponse,
  Candidate,
  JobCard,
  MatchAssessment,
} from '@/lib/agent/types';
import { CANDIDATES, JOBS, findJob } from '@/lib/fixtures/data';

type ChatMsg =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'agent'; text: string }
  | { id: string; role: 'system'; text: string }
  | { id: string; role: 'cards'; cards: JobCard[] }
  | {
      id: string;
      role: 'form';
      form: { formId: string; url: string; prefill: Record<string, string> };
    }
  | {
      id: string;
      role: 'approval';
      approvalId: string;
      summary: string;
      reason: string;
      draft: string;
      proposed: AgentAction[];
    };

type ApprovalMsg = Extract<ChatMsg, { role: 'approval' }>;

interface WireCall {
  carry: 'full' | 'reference';
  status: number;
  bytes: number;
}

interface Thread {
  candidate: Candidate;
  jobId: string;
  chat: ChatMsg[];
  lastReq: AgentRequest | null;
  lastRes: AgentResponse | null;
  wire: WireCall[];
  busy: boolean;
  /** 正在合并窗口里等——还没发出去 */
  waiting: boolean;
}

interface Part {
  id: string;
  text: string;
  sentAt: string;
}

/** 静默窗口：这段时间内没有再说话，就把攒下的当成一轮 */
const MERGE_WINDOW_MS = 1200;

let seq = 0;
const uid = () => `m${++seq}`;

const QUICK = [
  '还招人吗',
  '多少钱一个月',
  '包吃住吗',
  '能接受',
  '可以',
  '我只能上白班，要接孩子',
  '还有别的吗',
  '加个微信吧',
];

const INITIAL_JOB: Record<string, string> = {
  'cand-zhangwei': 'job-a',
  'cand-liguifang': 'job-b',
  'cand-wangqiang': 'job-a',
};

function systemMsg(jobId: string): ChatMsg {
  const j = findJob(jobId);
  return {
    id: uid(),
    role: 'system',
    text: j
      ? `你正在浏览：${j.title}（BOSS直聘 · 由 ${j.recruiter.name} 负责）`
      : '你正在浏览一个岗位',
  };
}

function makeThread(c: Candidate): Thread {
  const jobId = INITIAL_JOB[c.id] ?? 'job-a';
  return {
    candidate: c,
    jobId,
    chat: [systemMsg(jobId)],
    lastReq: null,
    lastRes: null,
    wire: [],
    busy: false,
    waiting: false,
  };
}

function bytesOf(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/** 服务端 actions → 气泡。审批卡也在这里，保证普通消息和恢复后的消息长得一样 */
function actionsToMsgs(actions: AgentAction[]): ChatMsg[] {
  const msgs: ChatMsg[] = [];
  for (const a of actions) {
    if (a.type === 'text') msgs.push({ id: uid(), role: 'agent', text: a.text });
    else if (a.type === 'job_cards') msgs.push({ id: uid(), role: 'cards', cards: a.jobs });
    else if (a.type === 'interview_form')
      msgs.push({
        id: uid(),
        role: 'form',
        form: { formId: a.formId, url: a.url, prefill: a.prefill },
      });
    else if (a.type === 'handoff')
      msgs.push({ id: uid(), role: 'system', text: `已转人工：${a.summary}` });
    else if (a.type === 'approval_request') {
      const draft = a.proposed.find((p) => p.type === 'text');
      msgs.push({
        id: uid(),
        role: 'approval',
        approvalId: a.approvalId,
        summary: a.summary,
        reason: a.reason,
        draft: draft?.type === 'text' ? draft.text : '',
        proposed: a.proposed,
      });
    }
  }
  return msgs;
}

export default function Page() {
  const [threads, setThreads] = useState<Record<string, Thread>>(() => {
    const out: Record<string, Thread> = {};
    for (const c of CANDIDATES) out[c.id] = makeThread(c);
    return out;
  });
  const [activeId, setActiveId] = useState(CANDIDATES[0]!.id);
  const [input, setInput] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<'request' | 'response' | 'trace'>('response');
  /**
   * 审批策略是**按动作**配的，不是一个全局 mode。
   * 这里只演示 interview_form 这一个副作用最大的动作。
   */
  const [approvalPolicy, setApprovalPolicy] = useState<'auto' | 'require'>('auto');

  const active = threads[activeId]!;
  const activeJob = findJob(active.jobId) ?? JOBS[0]!;
  const match = active.lastRes?.meta.match;

  const feedRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const lastLen = active.chat.length;

  // 连发合并的缓冲，按会话隔离
  const buffers = useRef<Record<string, { parts: Part[] }>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});
  const busyRef = useRef<Record<string, boolean>>({});
  /** 已经成功发过哪些 id@version，避免每轮都先撞一次 409 */
  const sentKeys = useRef<Set<string>>(new Set());
  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
    phoneRef.current?.scrollTo({ top: phoneRef.current.scrollHeight });
  }, [lastLen, activeId]);

  function patchThread(id: string, fn: (t: Thread) => Thread) {
    setThreads((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: fn(cur) };
    });
  }

  /**
   * 连发合并：Playground 在这里扮演业务端。
   * 用户连打三条，只发一个 turn 出去；窗口内又来了新的就顺延。
   * 真正的系统里这段在网关/BFF，agent 只接收合并后的 turn。
   */
  function send(raw: string) {
    const text = raw.trim();
    if (!text) return;
    const t = threadsRef.current[activeId];
    if (!t) return;

    setInput('');
    patchThread(activeId, (x) => ({
      ...x,
      chat: [...x.chat, { id: uid(), role: 'user', text }],
      waiting: true,
    }));

    const buf = buffers.current[activeId] ?? { parts: [] };
    buf.parts.push({
      id: `${activeId}:${Date.now()}-${buf.parts.length}`,
      text,
      sentAt: new Date().toISOString(),
    });
    buffers.current[activeId] = buf;

    const prev = timers.current[activeId];
    if (prev) clearTimeout(prev);
    timers.current[activeId] = setTimeout(() => flushTurn(activeId), MERGE_WINDOW_MS);
  }

  function flushTurn(id: string) {
    const buf = buffers.current[id];
    if (!buf || buf.parts.length === 0) return;
    if (busyRef.current[id]) {
      // 上一轮还没回，等它回来再发——不能同时开两个 turn
      timers.current[id] = setTimeout(() => flushTurn(id), 250);
      return;
    }
    const parts = buf.parts.splice(0);
    void runTurn(id, parts);
  }

  async function runTurn(id: string, parts: Part[]) {
    const t = threadsRef.current[id];
    if (!t || parts.length === 0) return;

    const job = findJob(t.jobId) ?? JOBS[0]!;
    const conversationId = `conv-${id}`;

    const candKey = `${t.candidate.id}@${t.candidate.updatedAt}`;
    const jobKey = `${job.id}@${job.updatedAt}`;

    /**
     * 业务端自己也记一份"这个版本发过没有"。
     * agent 那边是权威（409 兜底），但客户端记得住就不用每次都先试一遍。
     * 两个实例之间不一致、或者 agent 重启了，409 会把它拉回来。
     */
    const build = (withSnapshot: { candidate: boolean; jobOrder: boolean }): AgentRequest => ({
      platform: 'boss',
      conversationId,
      messages: parts.map((p) => ({
        messageId: p.id,
        type: 'text' as const,
        text: p.text,
        sentAt: p.sentAt,
      })),
      subject: {
        candidate: {
          id: t.candidate.id,
          version: t.candidate.updatedAt,
          ...(withSnapshot.candidate ? { snapshot: t.candidate } : {}),
        },
        jobOrder: {
          id: job.id,
          version: job.updatedAt,
          ...(withSnapshot.jobOrder ? { snapshot: job } : {}),
        },
      },
      recruiter: { id: job.recruiter.id, online: job.recruiter.online },
      // 不传＝全自动。只有显式切到 require 才走审批中断
      ...(approvalPolicy === 'require'
        ? {
            approvalPolicy: {
              default: 'auto' as const,
              overrides: { interview_form: 'require' as const },
            },
          }
        : {}),
    });

    const post = (req: AgentRequest) =>
      fetch('/api/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });

    busyRef.current[id] = true;
    patchThread(id, (x) => ({ ...x, busy: true, waiting: false }));

    const wire: WireCall[] = [];
    const warm = { candidate: sentKeys.current.has(candKey), jobOrder: sentKeys.current.has(jobKey) };

    try {
      let req = build({ candidate: !warm.candidate, jobOrder: !warm.jobOrder });
      let res = await post(req);
      wire.push({
        carry: warm.candidate && warm.jobOrder ? 'reference' : 'full',
        status: res.status,
        bytes: bytesOf(req),
      });

      // 兜底：agent 没见过这一版（重启、多实例、缓存淘汰）→ 补快照重发同一个 turn
      if (res.status === 409) {
        req = build({ candidate: true, jobOrder: true });
        res = await post(req);
        wire.push({ carry: 'full', status: res.status, bytes: bytesOf(req) });
      }

      if (res.ok) {
        sentKeys.current.add(candKey);
        sentKeys.current.add(jobKey);
      }

      const data = (await res.json()) as AgentResponse;
      const msgs = actionsToMsgs(data.actions);

      patchThread(id, (x) => ({
        ...x,
        chat: [...x.chat, ...msgs],
        lastReq: req,
        lastRes: data,
        wire,
        busy: false,
        waiting: false,
      }));
      setTab('response');
    } catch (e) {
      patchThread(id, (x) => ({
        ...x,
        chat: [...x.chat, { id: uid(), role: 'system', text: `请求失败：${String(e)}` }],
        busy: false,
        waiting: false,
      }));
    } finally {
      busyRef.current[id] = false;
      // 这一轮期间又攒了新消息，接着发
      const buf = buffers.current[id];
      if (buf && buf.parts.length > 0) {
        timers.current[id] = setTimeout(() => flushTurn(id), 250);
      }
    }
  }

  function dropPending(id: string) {
    const timer = timers.current[id];
    if (timer) clearTimeout(timer);
    timers.current[id] = undefined;
    delete buffers.current[id];
  }

  /**
   * 恢复审批：这是一次新的状态推进，必须用新的 messageId。
   * 通过＝执行存下来的提案；改一句＝改文本、保留动作；驳回＝回退。
   */
  async function resolveApproval(msg: ApprovalMsg, decision: 'approve' | 'edit' | 'reject') {
    const t = threadsRef.current[activeId];
    if (!t) return;

    let edited: AgentAction[] | undefined;
    if (decision === 'edit') {
      const next = window.prompt('改成要发的话（动作保持不变）', msg.draft);
      if (next == null) return;
      edited = [
        { type: 'text', text: next.trim() || msg.draft },
        ...msg.proposed.filter((p) => p.type !== 'text'),
      ];
    }

    busyRef.current[activeId] = true;
    patchThread(activeId, (x) => ({ ...x, busy: true }));

    try {
      const res = await fetch('/api/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: `m${++seq}`,
          platform: 'boss',
          conversationId: `conv-${activeId}`,
          resume: {
            approvalId: msg.approvalId,
            decision,
            ...(edited ? { editedActions: edited } : {}),
          },
        }),
      });

      const data = (await res.json()) as AgentResponse & { error?: string; hint?: string };
      if (!res.ok) throw new Error(data.hint ?? data.error ?? `HTTP ${res.status}`);

      const label =
        decision === 'approve' ? '已通过，按提案发送' : decision === 'edit' ? '已改过再发' : '已驳回';
      const msgs = actionsToMsgs(data.actions);

      patchThread(activeId, (x) => ({
        ...x,
        chat: [
          ...x.chat.map((m) =>
            m.role === 'approval' && m.approvalId === msg.approvalId
              ? { id: m.id, role: 'system' as const, text: `审批${label}` }
              : m,
          ),
          ...msgs,
        ],
        lastRes: data,
        busy: false,
      }));
      setTab('response');
    } catch (e) {
      patchThread(activeId, (x) => ({
        ...x,
        chat: [
          ...x.chat,
          { id: uid(), role: 'system', text: `审批恢复失败：${String(e)}` },
        ],
        busy: false,
      }));
    } finally {
      busyRef.current[activeId] = false;
    }
  }

  function switchJob(nextId: string) {
    const t = threads[activeId];
    if (!t || t.jobId === nextId) return;
    const job = findJob(nextId);
    dropPending(activeId);
    patchThread(activeId, (x) => ({
      ...x,
      jobId: nextId,
      chat: [
        ...x.chat,
        {
          id: uid(),
          role: 'system',
          text: `您更换了与该 BOSS 沟通的职位：${job?.title ?? nextId}`,
        },
      ],
      lastRes: null,
      lastReq: null,
      wire: [],
      waiting: false,
    }));
  }

  async function resetThread() {
    const t = threads[activeId];
    if (!t) return;
    dropPending(activeId);
    await fetch(`/api/v1/messages?conversationId=conv-${activeId}`, { method: 'DELETE' });
    patchThread(activeId, (x) => ({
      ...x,
      chat: [systemMsg(x.jobId)],
      lastRes: null,
      lastReq: null,
      wire: [],
      busy: false,
      waiting: false,
    }));
  }

  const lastWire = active.wire[active.wire.length - 1];

  return (
    <div className="app">
      <div className="stage">
        {/* ── ① 用户手机 ── */}
        <section className="pane">
          <header className="pane-head">
            <div>
              <div className="pane-title">① 用户手机</div>
              <div className="pane-sub">{active.candidate.basic.name} · BOSS直聘 IM</div>
            </div>
            <span className="badge neutral">在线</span>
          </header>

          <div className="jobs-bar">
            {JOBS.map((j) => (
              <button
                key={j.id}
                className={j.id === active.jobId ? 'active' : ''}
                onClick={() => switchJob(j.id)}
                title={j.title}
              >
                {j.id === 'job-a' ? 'A·电子厂' : j.id === 'job-b' ? 'B·包装厂' : 'C·餐饮'}
              </button>
            ))}
          </div>

          <div className="phone" ref={phoneRef}>
            <ChatFeed
              chat={active.chat}
              loading={active.busy || active.waiting}
              onClickCard={switchJob}
              onResolve={resolveApproval}
            />
          </div>

          <div className="quick">
            {QUICK.map((q) => (
              <button key={q} onClick={() => send(q)}>
                {q}
              </button>
            ))}
          </div>

          <div className="composer">
            <input
              value={input}
              placeholder="输入消息…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send(input);
              }}
            />
            <button className="btn" onClick={() => send(input)}>
              发送
            </button>
          </div>
        </section>

        {/* ── ② 会话列表 ── */}
        <section className="pane">
          <header className="pane-head">
            <div>
              <div className="pane-title">② 会话</div>
              <div className="pane-sub">{CANDIDATES.length} 个在聊</div>
            </div>
            <button className="btn-ghost" onClick={resetThread} title="清空本会话">
              重开
            </button>
          </header>

          <div className="chatlist">
            {CANDIDATES.map((c) => {
              const t = threads[c.id]!;
              const last = [...t.chat].reverse().find((m) => m.role !== 'system');
              const preview =
                last == null
                  ? '—'
                  : last.role === 'cards'
                    ? `[岗位卡片 × ${last.cards.length}]`
                    : last.role === 'form'
                      ? '[面试信息表]'
                      : last.role === 'approval'
                        ? '[待审批]'
                        : last.text;
              const state = t.lastRes?.state;
              return (
                <button
                  key={c.id}
                  className={`thread ${c.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(c.id)}
                >
                  <span className="avatar">{c.basic.name.slice(0, 1)}</span>
                  <span className="thread-body">
                    <span className="thread-top">
                      <span className="thread-name">{c.basic.name}</span>
                      <span className="thread-age">{c.basic.age}</span>
                    </span>
                    <span className="thread-last">{preview}</span>
                    <span className="thread-foot">
                      <span className={`mini ${state === 'FORM_SENT' ? 'ok' : ''}`}>
                        {state === 'FORM_SENT'
                          ? '已发表'
                          : state === 'PENDING_APPROVAL'
                            ? '待审批'
                            : state === 'TRANSFERRED'
                              ? '已转微信'
                              : state === 'CONFIRMING'
                                ? '待面试'
                                : state === 'MATCHING'
                                  ? '可谈'
                                  : state === 'COLLECTING'
                                    ? '待采集'
                                    : state === 'HANDOFF'
                                      ? '转人工'
                                      : 'AI 接待'}
                      </span>
                      <span className="muted">{findJob(t.jobId)?.jobType.split('-')[0]}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ── ③ 聊天 ── */}
        <section className="pane">
          <header className="pane-head">
            <div>
              <div className="pane-title">
                ③ {active.candidate.basic.name}
                <span className="muted" style={{ fontWeight: 400 }}>
                  {' '}
                  · {activeJob.recruiter.name}
                </span>
              </div>
              <div className="pane-sub">{activeJob.jobType}｜{activeJob.store.name}</div>
            </div>
            <div className="head-right">
              <label className="policy-select" title="审批按动作配：这里只管面试采集表">
                审批
                <select
                  value={approvalPolicy}
                  onChange={(e) => setApprovalPolicy(e.target.value as 'auto' | 'require')}
                >
                  <option value="auto">auto</option>
                  <option value="require">采集表需审批</option>
                </select>
              </label>
              <span className="badge neutral">{stateLabel(active.lastRes?.state)}</span>
              {match ? decisionBadge(match.decision) : null}
            </div>
          </header>

          <div className="chat-feed" ref={feedRef}>
            <ChatFeed
              chat={active.chat}
              loading={active.busy || active.waiting}
              onClickCard={switchJob}
              onResolve={resolveApproval}
            />
            <div className="chat-note">以上回复由 agent 代发，经纪人可随时接管</div>
          </div>
        </section>

        {/* ── ④ 资料 + 判定 ── */}
        <section className="pane">
          <header className="pane-head">
            <div>
              <div className="pane-title">④ 用户与职位</div>
              <div className="pane-sub">agent 的判断依据</div>
            </div>
            {match ? <span className="mono">{match.score}</span> : null}
          </header>

          <div className="work">
            <div className="section">
              <div className="section-head">
                <span>当前职位</span>
                <span className="mono">{activeJob.platformJobId.boss}</span>
              </div>
              <div className="section-body">
                <div className="kv">
                  <span className="k">标题</span>
                  <span className="v">{activeJob.title}</span>
                </div>
                <div className="kv">
                  <span className="k">薪资</span>
                  <span className="v">
                    保底 {activeJob.pay.base} / 综合 {activeJob.pay.displayMin}-
                    {activeJob.pay.displayMax}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">班次</span>
                  <span className="v">
                    {activeJob.schedule.shift.label} {activeJob.schedule.start}-{activeJob.schedule.end}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">在招</span>
                  <span className="v">
                    {activeJob.headcount.left}/{activeJob.headcount.total}
                  </span>
                </div>
              </div>
            </div>

            <div className="section">
              <div className="section-head">
                <span>候选人</span>
                <span className="muted">{active.candidate.basic.name}</span>
              </div>
              <div className="section-body">
                <div className="kv">
                  <span className="k">年龄 / 性别</span>
                  <span className="v">
                    {active.candidate.basic.age} /{' '}
                    {active.candidate.basic.gender === 'male' ? '男' : '女'}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">现居</span>
                  <span className="v">{active.candidate.current.district.name}</span>
                </div>
                <div className="kv">
                  <span className="k">期望</span>
                  <span className="v">{active.candidate.expect.salaryMin}+ 元/月</span>
                </div>
                <div className="kv">
                  <span className="k">健康证</span>
                  <span className="v">
                    {active.candidate.certificates.healthCert?.has ? '有' : '没有（可入职前办）'}
                  </span>
                </div>
              </div>
            </div>

            {match ? (
              <>
                <div className="section">
                  <div className="section-head">
                    <span>硬条件（一票否决）</span>
                  </div>
                  <div className="section-body">
                    {match.blocking.map((b) => (
                      <div key={b.field} className="check">
                        <span className={`dot ${b.pass ? 'pass' : 'fail'}`} />
                        <span className="k">{b.field}</span>
                        <span className="v">
                          {b.actual} / 需 {b.required}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="section">
                  <div className="section-head">
                    <span>可谈项</span>
                    <span className="muted">5% / 10%</span>
                  </div>
                  <div className="section-body">
                    {match.negotiable.map((n) => (
                      <div key={n.field} className="check">
                        <span
                          className={`dot ${
                            n.verdict === 'ok' ? 'pass' : n.verdict === 'probe' ? 'probe' : 'fail'
                          }`}
                        />
                        <span className="k">{n.field}</span>
                        <span className="v">
                          {n.expected} / {n.actual}
                          {n.gapPct ? ` · ${n.gapPct > 0 ? '差' : '高'} ${Math.abs(n.gapPct)}%` : ''}
                          {n.hard ? ' · 硬' : ''}
                        </span>
                      </div>
                    ))}
                    {match.negotiable.map((n) =>
                      n.note ? (
                        <div key={`${n.field}-note`} className="hint">
                          {n.field}：{n.note}
                        </div>
                      ) : null,
                    )}
                  </div>
                </div>

                {match.openQuestions.length > 0 && (
                  <div className="section">
                    <div className="section-head">
                      <span>待确认</span>
                      <span className="muted">挡住发表</span>
                    </div>
                    <div className="section-body">
                      {match.openQuestions.map((q) => (
                        <div key={q.field} className="check">
                          <span className="dot unknown" />
                          <span className="v">{q.question}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="section">
                  <div className="section-head">
                    <span>判定</span>
                  </div>
                  <div className="section-body">
                    <div className="kv">
                      <span className="k">decision</span>
                      <span className="mono">{match.decision}</span>
                    </div>
                    <div className="kv">
                      <span className="k">state</span>
                      <span className="mono">{active.lastRes?.state}</span>
                    </div>
                    <div className="kv">
                      <span className="k">action</span>
                      <span className="mono">{active.lastRes?.meta.action ?? '—'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">topics</span>
                      <span className="v">{active.lastRes?.meta.topics.join('、') || '—'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">理由</span>
                      <span className="v">{match.reasons.join('、') || '—'}</span>
                    </div>
                    {match.probe && (
                      <div className="hint">试探：{match.probe.question}</div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="section">
                <div className="section-body">
                  <div className="empty">发一条消息，这里会出现判定依据</div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── ⑤ 服务视角（底部抽屉） ── */}
      <section className={`drawer ${drawerOpen ? 'open' : ''}`}>
        <header className="drawer-head">
          <button className="drawer-toggle" onClick={() => setDrawerOpen((v) => !v)}>
            {drawerOpen ? '▾' : '▸'} 服务视角
            <span className="muted"> · 业务端看到的东西</span>
          </button>
          {lastWire && (
            <span className="mono muted">
              {active.wire.map((w, i) => (
                <span key={i}>
                  {i > 0 ? ' → ' : ''}
                  {w.status} {w.carry === 'full' ? '带快照' : '仅引用'} {fmtBytes(w.bytes)}
                </span>
              ))}
            </span>
          )}
          <span className={`model-chip ${active.lastRes?.meta.degraded ? 'warn' : ''}`}>
            {active.lastRes?.meta.model ?? '未请求'}
            {active.lastRes?.meta.degraded ? ' · 已降级' : ''}
            {active.lastRes ? ` · ${active.lastRes.meta.promptVersion}` : ''}
          </span>
          <div className="tabs">
            {(['request', 'response', 'trace'] as const).map((t) => (
              <button
                key={t}
                className={`tab ${tab === t ? 'active' : ''}`}
                onClick={() => {
                  setTab(t);
                  setDrawerOpen(true);
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </header>

        <div className="drawer-body">
          {tab === 'request' && (
            <pre className="code">
              {active.lastReq
                ? JSON.stringify(active.lastReq, null, 2)
                : '// 还没有请求。注意稳态下 subject 里只有 id 和 version'}
            </pre>
          )}
          {tab === 'response' && (
            <pre className="code">
              {active.lastRes
                ? JSON.stringify(active.lastRes, null, 2)
                : '// 还没有响应'}
            </pre>
          )}
          {tab === 'trace' && (
            <pre className="code">
              {active.lastRes
                ? active.lastRes.trace
                    .map(
                      (s, i) =>
                        `${String(i + 1).padStart(2, '0')}  ${s.node.padEnd(8)} ${s.detail}  (${s.ms}ms)`,
                    )
                    .join('\n')
                : '// 还没有 trace'}
            </pre>
          )}
        </div>
      </section>
    </div>
  );
}

// ── 子组件 ───────────────────────────────────────────────────

function ChatFeed({
  chat,
  loading,
  onClickCard,
  onResolve,
}: {
  chat: ChatMsg[];
  loading: boolean;
  onClickCard: (jobId: string) => void;
  onResolve: (msg: ApprovalMsg, decision: 'approve' | 'edit' | 'reject') => void;
}) {
  return (
    <>
      {chat.map((m) => {
        if (m.role === 'system')
          return (
            <div key={m.id} className="bubble system">
              {m.text}
            </div>
          );
        if (m.role === 'user')
          return (
            <div key={m.id} className="row user">
              <div className="bubble user">{m.text}</div>
            </div>
          );
        if (m.role === 'agent')
          return (
            <div key={m.id} className="row">
              <div className="bubble agent">{m.text}</div>
            </div>
          );
        if (m.role === 'cards')
          return (
            <div key={m.id} className="cards">
              {m.cards.map((c) => (
                <button key={c.jobOrderId} className="card" onClick={() => onClickCard(c.jobOrderId)}>
                  <div className="card-title">{c.title}</div>
                  <div className="card-salary">{c.salaryText}</div>
                  <div className="card-tags">
                    {c.tags.slice(0, 4).map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className="card-meta">
                    {c.platformLabel} · {c.district}
                    {c.commuteLabel ? ` · ${c.commuteLabel}` : ''}
                    {c.recruiterName ? ` · ${c.recruiterName}` : ''}
                    {c.reason ? ` · ${c.reason}` : ''}
                  </div>
                </button>
              ))}
            </div>
          );
        if (m.role === 'approval')
          return (
            <div key={m.id} className="approval-card">
              <div className="approval-head">
                <span className="approval-badge">待审批</span>
                <span className="approval-summary">{m.summary}</span>
              </div>
              <div className="approval-reason">{m.reason}</div>
              {m.draft ? <div className="approval-draft">{m.draft}</div> : null}
              <div className="approval-actions">
                <button className="btn tiny" onClick={() => onResolve(m, 'approve')}>
                  通过并发送
                </button>
                <button
                  className="btn-ghost tiny"
                  onClick={() => onResolve(m, 'edit')}
                  title="改文本，动作保持不变"
                >
                  改一句
                </button>
                <button className="btn-ghost tiny danger" onClick={() => onResolve(m, 'reject')}>
                  驳回
                </button>
              </div>
            </div>
          );
        return (
          <div key={m.id} className="form-card">
            <div className="card-title">面试信息确认</div>
            {Object.entries(m.form.prefill).map(([k, v]) => (
              <div key={k} className="form-row">
                <span className="muted">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
            <div className="form-row">
              <span className="muted">可选时间</span>
              <span className="v">8月25日 10:00 / 14:00</span>
            </div>
          </div>
        );
      })}
      {loading && <div className="bubble system">对方正在输入…</div>}
    </>
  );
}

function fmtBytes(n: number) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

function stateLabel(s?: AgentResponse['state']) {
  switch (s) {
    case 'PENDING_APPROVAL':
      return '待审批';
    case 'TRANSFERRED':
      return '已转微信';
    case 'FORM_SENT':
      return '已发表';
    case 'CONFIRMING':
      return '待面试';
    case 'MATCHING':
      return '可谈';
    case 'COLLECTING':
      return '待采集';
    case 'HANDOFF':
      return '转人工';
    case 'GREETING':
      return '未开始';
    default:
      return 'AI 接待';
  }
}

function decisionBadge(d: MatchAssessment['decision']) {
  const map: Record<MatchAssessment['decision'], { cls: string; label: string }> = {
    auto_match: { cls: 'ok', label: '匹配' },
    suggest: { cls: 'warn', label: '需确认' },
    negotiable: { cls: 'warn', label: '可谈' },
    not_match: { cls: 'bad', label: '不匹配' },
    insufficient_data: { cls: 'neutral', label: '信息不足' },
  };
  const { cls, label } = map[d];
  return <span className={`badge ${cls}`}>{label}</span>;
}

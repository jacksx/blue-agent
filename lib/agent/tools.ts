import type { Candidate, JobOrder } from './types';
import { JOBS } from '@/lib/fixtures/data';
import { POLICY_HINT_RE, retrieve, type PolicyLookup } from '@/lib/rag/retrieve';
import type { Understanding } from './nlu';

/**
 * 工具层。
 *
 * 边界只有一句话：**入口上下文不通过工具，其余全部通过工具。**
 *
 *   "这一次请求要处理的是哪个岗位、哪个候选人"  → 业务端随请求推过来
 *   "库里还有哪些别的岗位"                      → 必须调工具查
 *
 * 为什么这么切：
 *   · 入口数据是这次请求的前提，没有它连判定都开始不了；push 过来少一次往返，
 *     也能让 agent 不持有业务库凭据（权限收敛在业务端）。
 *   · 岗位池是"库里其他数据"，属于 agent 主动去查的东西，agent 不该有副本。
 *
 * 之前这里偷懒了：orchestrator 直接 import JOBS，等于 agent 私存了一份岗位库。
 * 现在改成必须经过 AgentTools，换 Supabase 时只换实现。
 */

export interface JobSearchInput {
  candidate: Candidate;
  /** 当前正在聊的岗位，召回时排除 */
  currentJobId: string;
  limit: number;
}

/** 决策时需要的上下文：工具提前取好，决策本身仍然是纯函数 */
export interface DecisionContext {
  jobPool: JobOrder[];
  /** 工具耗时，写进 trace 用 */
  searchMs?: number;
  /** 政策/FAQ 检索结果；没查或拒答时为空 */
  policy?: PolicyLookup;
}

export interface AgentTools {
  /**
   * 召回可以推给这个人的岗位池。
   *
   * 真实实现（W2）：
   *   select ... from job_orders
   *   where city = $1 and status = 'open' and headcount_left > 0
   *     and id <> $2
   *   limit $3
   * 再叠加向量召回做语义补漏。这里只做结构化预筛，语义打分在 recommend.ts。
   */
  searchJobPool(input: JobSearchInput): JobOrder[];

  /** 政策答疑检索。结构化字段答不了的问题才走这里 */
  searchPolicy(query: string): PolicyLookup;
}

/**
 * 什么时候该查知识库。
 *
 * 判断依据只有三类：
 *   1. 规则/模型都归不了类（other）——典型是"体检费谁出"
 *   2. 模型自己承认有归不了的诉求（unclear）
 *   3. 命中了明确属于政策域的词（押金/合同/请假/夫妻房…）
 *
 * 结构化字段能答的（薪资、班次、地址）**绝不**走向量——
 * 查库比检索准，而且岗位事实会在不同 chunk 之间漂移。
 */
export function shouldLookupPolicy(
  text: string,
  understanding?: Understanding,
): boolean {
  if (!text.trim()) return false;
  if (understanding?.unclear) return true;

  const topics = understanding?.topics ?? [];
  if (topics.includes('contact')) return false;
  if (topics.length === 0) return false;
  if (topics.includes('other')) return true;

  return POLICY_HINT_RE.test(text);
}

export function createFixtureTools(): AgentTools {
  return {
    searchJobPool({ currentJobId, limit }) {
      return JOBS.filter((j) => j.id !== currentJobId && j.status === 'open').slice(0, limit);
    },
    searchPolicy(query) {
      return retrieve(query, 'hybrid+rerank');
    },
  };
}

/** 默认实现：fixture。接库时换掉它，orchestrator 一行不用改 */
export const defaultTools: AgentTools = createFixtureTools();

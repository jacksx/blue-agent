import type { Candidate, JobCard, JobOrder, Platform } from './types';
import { commuteLabelOf, salaryBrief } from './match';

/**
 * 岗位卡片。
 *
 * 一条硬约束（§2.15）：卡片必须映射回**当前平台**的 id。
 * BOSS 会话里点开店长直聘的 id，用户看到的就是"岗位不存在"。
 * 同时把归属顾问写在卡上——跨经纪人推荐时，用户有权知道换人了。
 */
export const PLATFORM_LABEL: Record<Platform, string> = {
  boss: 'BOSS直聘',
  dianzhang: '店长直聘',
};

export function toCard(
  job: JobOrder,
  cand: Candidate,
  reason: string,
  platform: Platform,
): JobCard {
  const loc = job.locations[0]!;
  return {
    jobOrderId: job.id,
    platformJobId: job.platformJobId[platform],
    platform,
    platformLabel: PLATFORM_LABEL[platform],
    title: job.title,
    salaryText: salaryBrief(job),
    tags: job.tags,
    district: loc.district.name,
    commuteLabel: commuteLabelOf(job, cand),
    recruiterName: job.recruiter.name,
    reason,
  };
}

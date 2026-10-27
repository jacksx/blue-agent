import type { Candidate, District, JobOrder } from '@/lib/agent/types';

// ─────────────────────────────────────────────────────────────
// 种子数据：3 个候选人 + 3 个岗位
//
// 形状照着「发布表单」来：
//   · 固定配置项 → 存 code，不存中文
//   · 给机器算的   → 存 number，不存"6-8 人间"这种句子
//   · 只有备注     → 才留自由文本
// ─────────────────────────────────────────────────────────────

const BASE_TIME = '2026-10-22T09:00:00+08:00';

const XIAOSHAN: District = { code: '330109', name: '萧山区' };
const BINJIANG: District = { code: '330108', name: '滨江区' };
const YUHANG: District = { code: '330110', name: '余杭区' };

export const DISTRICTS = { XIAOSHAN, BINJIANG, YUHANG };

export const JOBS: JobOrder[] = [
  {
    id: 'job-a',
    platformJobId: { boss: 'boss-8f3a21', dianzhang: 'dz-2c91a0' },
    platformEnabled: ['boss', 'dianzhang'],
    title: '电子厂普工/可日结/280一天', // 营销文案，不作事实源
    positionName: '普工/操作工',
    positionCode: 'operator',
    jobType: '普工-普工/操作工',
    employmentType: 'full',
    headcount: { total: 20, left: 12 },
    store: { id: 'store-1', name: '杭州欣胜电子' },
    category: 'factory',
    locations: [
      {
        address: '杭州市滨江区长河街道建业路 88 号',
        geo: { lat: 30.2084, lng: 120.2119 },
        district: BINJIANG,
        isPrimary: true,
      },
    ],
    pay: {
      displayMin: 5000,
      displayMax: 6500,
      mode: 'monthly',
      base: 2490,
      fullAttendance: 300,
      overtime: { weekday: 1.5, weekend: 2, holiday: 3, startAfter: '17:00' },
      payDayOfMonth: 15,
      payDayNextMonth: true,
      settle: 'monthly',
      advance: { allowed: true, afterDays: 7 },
    },
    schedule: {
      shift: { code: 'two_shift', label: '两班倒', norm: 'mapped' },
      rest: { code: 'work_6_rest_1', label: '做六休一', norm: 'mapped' },
      restDaysPerMonth: 4, // 做六休一 ≈ 一个月休 4 天
      start: '08:00',
      end: '20:00',
      breakIncluded: true,
      breakMinutes: 120,
      overtimeAfter: '17:00',
    },
    requirements: {
      ageMin: 18,
      ageMax: 45,
      gender: 'any',
      education: 'none',
      experience: 'none',
      healthCert: true,
      acceptsNightShift: true,
      acceptsRotating: true,
      skills: { codes: ['line', 'assembly', 'scan'], custom: [] },
      other: ['身体健康', '服从安排'],
    },
    benefits: {
      insurance: { codes: ['social', 'accident'], custom: [] },
      bonus: { codes: ['full_attendance'], custom: [] },
      living: { codes: ['dorm_included'], custom: [] },
      mealNote: '厂里有食堂，一顿 8-12 元',
      dorm: { capacityMin: 6, capacityMax: 8, facilities: ['ac', 'water_heater'] },
    },
    description: {
      raw: '工厂直招，当天可约面试，接受无经验，有师傅带教。主要看机器、组装、贴标签。',
      environment: '车间恒温，站着上班',
      content: ['组装', '测试', '包装', '贴标签'],
      highlights: ['当天安排面试', '可预支'],
    },
    recruiter: {
      id: 'rec-1',
      name: '陈雨青',
      role: '人事',
      online: true,
      verified: true,
      repliesToday: 12,
      replyRate: 0.92,
    },
    tags: ['热招中', '包住', '学历不限'],
    updatedAt: BASE_TIME,
    status: 'open',
  },

  {
    id: 'job-b',
    platformJobId: { boss: 'boss-7d10bb', dianzhang: 'dz-99f4c1' },
    platformEnabled: ['boss', 'dianzhang'],
    title: '包装工/长白班/包住有餐补',
    positionName: '包装工',
    positionCode: 'packer',
    jobType: '普工-包装工',
    employmentType: 'full',
    headcount: { total: 5, left: 3 },
    store: { id: 'store-2', name: '萧山宁围包装厂' },
    category: 'factory',
    locations: [
      {
        address: '杭州市萧山区宁围街道市心北路 66 号',
        geo: { lat: 30.2451, lng: 120.2831 },
        district: XIAOSHAN,
        isPrimary: true,
      },
    ],
    pay: {
      displayMin: 6500,
      displayMax: 7200,
      mode: 'monthly',
      base: 5500,
      fullAttendance: 300,
      performance: 400,
      overtime: { weekday: 1.5, weekend: 2, holiday: 3, startAfter: '17:00' },
      payDayOfMonth: 10,
      payDayNextMonth: true,
      settle: 'monthly',
      advance: { allowed: true, afterDays: 15 },
    },
    schedule: {
      shift: { code: 'day', label: '长白班', norm: 'mapped' },
      rest: { code: 'monthly_4', label: '月休四天', norm: 'mapped' },
      restDaysPerMonth: 4,
      start: '08:00',
      end: '17:00',
      breakIncluded: true,
      breakMinutes: 60,
    },
    requirements: {
      ageMin: 18,
      ageMax: 42,
      gender: 'any',
      education: 'none',
      experience: 'none',
      healthCert: true,
      acceptsNightShift: false,
      acceptsRotating: false,
      skills: { codes: ['inspect', 'pack', 'scan'], custom: ['会用打包机'] },
      other: ['身体健康'],
    },
    benefits: {
      insurance: { codes: ['social', 'accident'], custom: [] },
      bonus: { codes: ['meal_subsidy', 'full_attendance'], custom: [] },
      living: { codes: ['dorm_included'], custom: [] },
      mealSubsidyPerDay: 15,
      dorm: {
        capacityMin: 4,
        capacityMax: 6,
        facilities: ['ac', 'wifi', 'water_heater', 'washer'],
        walkMinutes: 10,
      },
    },
    description: {
      raw: '贴标打包，坐着上班，不穿无尘服。0 费用入职，厂区直接对接面试。',
      environment: '24 小时中央空调，坐着上班',
      content: ['贴标签', '扫码', '打包', '巡检'],
      highlights: ['0 费用入职', '宿舍步行 10 分钟'],
    },
    recruiter: {
      id: 'rec-2',
      name: '沈嘉诚',
      role: '招聘者',
      online: true,
      verified: true,
      repliesToday: 30,
      replyRate: 0.96,
    },
    tags: ['热招中', '包住', '餐补'],
    updatedAt: BASE_TIME,
    status: 'open',
  },

  {
    id: 'job-c',
    platformJobId: { boss: 'boss-3b7e02', dianzhang: 'dz-1a55d7' },
    platformEnabled: ['boss', 'dianzhang'],
    title: '餐饮服务员/包吃住/月休五天',
    positionName: '服务员',
    positionCode: 'waiter',
    jobType: '生活服务-服务员',
    employmentType: 'full',
    headcount: { total: 6, left: 4 },
    store: { id: 'store-3', name: '牛匠餐饮（滨江银泰店）' },
    category: 'food',
    locations: [
      {
        address: '杭州市滨江区西兴街道江南大道 228 号',
        geo: { lat: 30.1955, lng: 120.2202 },
        district: BINJIANG,
        isPrimary: true,
      },
    ],
    pay: {
      displayMin: 5500,
      displayMax: 6000,
      mode: 'monthly',
      base: 5000,
      performance: 500,
      payDayOfMonth: 15,
      payDayNextMonth: true,
      settle: 'monthly',
    },
    // 「月休五天」表单里没有，是运营自定义的 → 标 unmapped，不拿去算
    schedule: {
      shift: { code: 'day', label: '长白班', norm: 'mapped' },
      rest: { code: null, label: '月休五天', norm: 'unmapped' },
      restDaysPerMonth: null,
      start: '09:00',
      end: '17:00',
      breakIncluded: true,
      breakMinutes: 60,
    },
    requirements: {
      ageMin: 18,
      ageMax: 45,
      gender: 'any',
      education: 'none',
      experience: 'none',
      healthCert: true,
      acceptsNightShift: false,
      acceptsRotating: false,
      skills: { codes: ['order', 'serve', 'greet', 'cashier'], custom: [] },
      other: ['普通话标准'],
    },
    benefits: {
      insurance: { codes: ['accident'], custom: [] },
      bonus: { codes: ['performance'], custom: [] },
      // 这一组两个都选了：包吃 + 包住
      living: { codes: ['meal_included', 'dorm_included'], custom: ['包三餐'] },
      dorm: { capacityMin: 4, capacityMax: 4, walkMinutes: 15 },
    },
    description: {
      raw: '1.薪资：保底 5000 加绩效，综合 5500+。2.待遇：月休五天。3.食宿：包三餐包住宿。',
      environment: '室内餐厅，环境干净',
      content: ['点单', '传菜', '收银'],
      highlights: ['包三餐', '宿舍步行 15 分钟'],
    },
    recruiter: {
      id: 'rec-3',
      name: '胡清雅',
      role: '人事经理',
      online: true,
      verified: true,
      repliesToday: 90,
      replyRate: 0.98,
    },
    tags: ['包吃', '包住', '月休五天'],
    updatedAt: BASE_TIME,
    status: 'open',
  },
];

export const CANDIDATE: Candidate = {
  id: 'cand-zhangwei',
  basic: { name: '张伟', gender: 'male', age: 38, phone: '138****5678' },
  jobStatus: '离职-随时到岗',
  jobType: '全职',
  expect: { positionCodes: ['operator', 'packer'], salaryMin: 6000, salaryMax: 6500 },
  skills: { codes: ['line', 'assembly', 'scan'], custom: [] },
  advantages: ['熟悉生产流水线', '接受倒班', '普通话标准'],
  experiences: [
    { title: '普工操作工', company: '利群电子厂', start: '2022.1', end: null },
    { title: '服务员', company: '茶百道', start: '2018.5', end: '2022.4' },
  ],
  education: [{ school: '武汉职业技术大学', degree: '大专', start: '2015', end: '2018' }],
  certificates: { healthCert: { has: false, expiry: '2025-11', uploaded: false } },
  current: { city: '杭州市', district: { code: '330109', name: '萧山区' } },
  constraints: [],
  updatedAt: BASE_TIME,
};

/** 三个候选人不是摆设：他们让"同一个岗位对不同人判定不同"这件事可验证 */
export const CANDIDATES: Candidate[] = [
  CANDIDATE,
  {
    id: 'cand-liguifang',
    basic: { name: '李桂芳', gender: 'female', age: 41, phone: '139****2210' },
    jobStatus: '离职-随时到岗',
    jobType: '全职',
    expect: { positionCodes: ['packer', 'waiter'], salaryMin: 5000, salaryMax: 5500 },
    skills: { codes: ['pack', 'scan', 'inspect'], custom: ['会用打包机'] },
    advantages: ['做事细致', '手脚快'],
    experiences: [
      { title: '包装工', company: '恒美包装', start: '2019.3', end: '2026.8' },
      { title: '超市理货员', company: '联华', start: '2015.6', end: '2019.1' },
    ],
    education: [{ school: '杭州市萧山区第二职高', degree: '中专', start: '1999', end: '2002' }],
    certificates: { healthCert: { has: true, expiry: '2027-3', uploaded: true } },
    current: { city: '杭州市', district: { code: '330108', name: '滨江区' } },
    constraints: ['包吃'],
    updatedAt: BASE_TIME,
  },
  {
    id: 'cand-wangqiang',
    basic: { name: '王强', gender: 'male', age: 26, phone: '150****9931' },
    jobStatus: '在职-考虑机会',
    jobType: '全职',
    expect: { positionCodes: ['operator'], salaryMin: 7000, salaryMax: 7500 },
    skills: { codes: ['line', 'assembly', 'scan'], custom: [] },
    advantages: ['能熬夜班', '手速快'],
    experiences: [{ title: '操作工', company: '深圳富士康', start: '2020.9', end: '2025.12' }],
    education: [{ school: '河南工业职业技术学院', degree: '大专', start: '2017', end: '2020' }],
    certificates: { healthCert: { has: false, uploaded: false } },
    current: { city: '杭州市', district: { code: '330109', name: '萧山区' } },
    constraints: [],
    updatedAt: BASE_TIME,
  },
];

export function findJob(id: string): JobOrder | undefined {
  return JOBS.find((j) => j.id === id);
}

export function findCandidate(id: string): Candidate | undefined {
  return CANDIDATES.find((c) => c.id === id);
}

export function jobByPlatformId(platform: 'boss' | 'dianzhang', pid: string): JobOrder | undefined {
  return JOBS.find((j) => j.platformJobId[platform] === pid);
}

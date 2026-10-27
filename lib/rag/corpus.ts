/**
 * 政策 / FAQ 知识库（RAG 用）。
 *
 * 为什么是"政策"而不是"岗位"：
 *   岗位事实（薪资、班次、地址）在结构化字段里，查库比检索准，不该走向量。
 *   真正需要检索的是**运营维护的规则类问题**：体检费谁出、押金收不收、
 *   合同什么时候签、离职怎么结算。这些不在岗位单里，也不该让模型现编。
 *
 * 切分按"一个可独立回答的问题"来，不按字数切。
 * 每条 chunk 都带 keywords：查询重写和 rerank 都用它。
 */

export type PolicyCategory =
  | 'settlement'
  | 'health'
  | 'onboarding'
  | 'accommodation'
  | 'meal'
  | 'shift'
  | 'insurance'
  | 'attendance'
  | 'platform'
  | 'interview'
  | 'eligibility'
  | 'fees';

export interface PolicyChunk {
  id: string;
  category: PolicyCategory;
  title: string;
  text: string;
  keywords: string[];
}

export const POLICY_CHUNKS: PolicyChunk[] = [
  {
    id: 'settlement.payday',
    category: 'settlement',
    title: '发薪日与结算方式',
    text: '发薪日每个岗位不一样，岗位单上会写明，一般是次月 10 到 15 号打卡。我们这边不压工资，遇到节假日会提前发。',
    keywords: ['发薪', '几号发', '工资', '压工资', '打卡', '结算', '次月'],
  },
  {
    id: 'settlement.advance',
    category: 'settlement',
    title: '工资预支',
    text: '大部分岗位支持预支：上班满 7 天可以预支一次，额度不超过已上班天数对应的工资。找驻厂或人事登记就行。',
    keywords: ['预支', '借钱', '先给', '垫付', '支工资'],
  },
  {
    id: 'settlement.leave',
    category: 'settlement',
    title: '离职与结算',
    text: '离职提前 3 天跟驻厂说，办好交接就行；工资按实际出勤结算，人走账清，不扣违约金。',
    keywords: ['离职', '辞职', '走人', '不干了', '结算', '违约金'],
  },
  {
    id: 'settlement.overtime_pay',
    category: 'settlement',
    title: '加班费怎么算',
    text: '超出正常班次的工时算加班：工作日 1.5 倍，周末 2 倍，法定节假日 3 倍，和工资一起发。加班是自愿的，不强制。',
    keywords: ['加班费', '加班', '1.5 倍', '两倍', '三倍', '工时', '强制'],
  },
  {
    id: 'settlement.deduction',
    category: 'settlement',
    title: '工资里会扣什么',
    text: '工资只扣法定部分：个税、社保个人部分，以及宿舍水电这类代扣项目，每一项都会在工资条上列清楚。',
    keywords: ['扣钱', '扣款', '工资条', '个税', '水电费', '代扣'],
  },
  {
    id: 'health.certificate',
    category: 'health',
    title: '健康证要求',
    text: '食品、餐饮类岗位必须有健康证，电子厂、包装厂也要。没有的可以入职前办，办证期间可以先安排面试。',
    keywords: ['健康证', '办证', '体检', '过期', '餐饮', '食品'],
  },
  {
    id: 'health.exam_fee',
    category: 'health',
    title: '体检费谁出',
    text: '入职体检费一般 50 元左右，先自己垫付，上班满一个月随工资报销。体检项目是肝功能、胸透、血常规这几项。',
    keywords: ['体检费', '体检', '谁出钱', '报销', '50', '费用'],
  },
  {
    id: 'health.exam_items',
    category: 'health',
    title: '体检项目',
    text: '常规入职体检就三项：肝功能、胸透、血常规，当天能出结果。有健康证且在有效期内的，不用重复体检。',
    keywords: ['体检项目', '查什么', '肝功能', '胸透', '血常规', '有效期'],
  },
  {
    id: 'onboarding.materials',
    category: 'onboarding',
    title: '入职要带什么',
    text: '入职带身份证原件、本人银行卡（发工资用）、一寸照片两张。健康证有的带上，没有的按上面说的补办。',
    keywords: ['入职', '带什么', '身份证', '银行卡', '照片', '材料'],
  },
  {
    id: 'onboarding.contract',
    category: 'onboarding',
    title: '劳动合同与试用期',
    text: '入职当天签劳动合同，一式两份，你自己留一份。试用期一般 1 到 3 个月，试用期工资不低于正式的 80%。',
    keywords: ['合同', '劳动合同', '试用期', '签合同', '80%'],
  },
  {
    id: 'fees.no_deposit',
    category: 'fees',
    title: '收不收费、押金',
    text: '入职不收任何费用：不押身份证、不收押金、不收服装费和中介费。遇到有人收费直接举报。',
    keywords: ['押金', '收费', '服装费', '中介费', '身份证', '0 费用'],
  },
  {
    id: 'accommodation.dorm',
    category: 'accommodation',
    title: '宿舍条件',
    text: '宿舍 4 到 8 人间，有空调、热水器，部分厂区带独立卫浴和 WiFi。水电网费按人头均摊，从工资里代扣。',
    keywords: ['宿舍', '住宿', '几人间', '空调', '热水器', 'WiFi', '水电费'],
  },
  {
    id: 'accommodation.couple',
    category: 'accommodation',
    title: '夫妻房',
    text: '夫妻房数量有限，需要提前跟驻厂申请，两人都在职才能安排。申请不到的先住集体宿舍，后续有空房再调。',
    keywords: ['夫妻房', '两口子', '老婆', '老公', '一起住', '申请'],
  },
  {
    id: 'accommodation.outside',
    category: 'accommodation',
    title: '外宿与房补',
    text: '不住宿舍可以申请外宿补贴，一般每月 100 到 200 元，随工资发。外宿要自己解决通勤，太远的话建议先看班车路线。',
    keywords: ['外宿', '房补', '不住宿舍', '租房', '补贴'],
  },
  {
    id: 'meal.canteen',
    category: 'meal',
    title: '吃饭与餐补',
    text: '有食堂的厂区一顿 8 到 12 元，部分岗位包吃或给餐补，餐补一般 15 元一天，随工资发。',
    keywords: ['吃饭', '食堂', '餐补', '包吃', '管饭', '伙食'],
  },
  {
    id: 'shift.night',
    category: 'shift',
    title: '夜班与倒班',
    text: '两班倒一般半个月换一次班，夜班有夜班补贴，具体金额看岗位单。不能上夜班的可以只考虑长白班岗位。',
    keywords: ['夜班', '倒班', '两班倒', '换班', '夜班补贴', '白班'],
  },
  {
    id: 'insurance.social',
    category: 'insurance',
    title: '社保什么时候交',
    text: '正式入职后开始缴社保，一般是入职当月或次月，五险按当地基数交。只想买意外险的岗位会在岗位单里写明。',
    keywords: ['社保', '五险', '公积金', '缴纳', '意外险', '什么时候交'],
  },
  {
    id: 'attendance.leave',
    category: 'attendance',
    title: '请假怎么请',
    text: '请假提前一天跟线长或驻厂报备，病假补个证明就行。急事可以直接打电话，别不打招呼就不来。',
    keywords: ['请假', '病假', '事假', '报备', '不来'],
  },
  {
    id: 'attendance.late',
    category: 'attendance',
    title: '迟到与旷工',
    text: '迟到按考勤制度处理，偶尔一次不会扣很多；无故旷工影响全勤奖，连续旷工按自动离职处理。',
    keywords: ['迟到', '旷工', '全勤', '考勤', '扣钱'],
  },
  {
    id: 'platform.wechat',
    category: 'platform',
    title: '换微信与站外联系',
    text: '平台上有「换微信」按钮，点了会话会转到微信，由顾问继续对接。为了你的账号安全，聊天里不要发手机号和微信号。',
    keywords: ['微信', '换微信', '加微信', '手机号', '站外', '转出'],
  },
  {
    id: 'platform.privacy',
    category: 'platform',
    title: '隐私与信息安全',
    text: '你的简历和聊天记录只用于这次求职，不会透露给其他求职者。身份证、银行卡照片只在入职时由人事核验。',
    keywords: ['隐私', '信息', '泄露', '简历', '安全', '身份证照片'],
  },
  {
    id: 'platform.report',
    category: 'platform',
    title: '举报与投诉',
    text: '遇到收费、扣证件、虚假岗位，可以在平台举报，也可以直接找驻厂投诉。核实后我们会终止合作并退还相关费用。',
    keywords: ['举报', '投诉', '骗', '收费', '虚假', '维权'],
  },
  {
    id: 'interview.process',
    category: 'interview',
    title: '面试流程',
    text: '到厂面试带身份证就行，先填表再和人事聊，一般当天出结果。通过后次日或约定时间入职。',
    keywords: ['面试', '到厂', '流程', '当天', '带什么', '结果'],
  },
  {
    id: 'interview.location',
    category: 'interview',
    title: '面试地点与路线',
    text: '面试地点就是岗位单上的厂区地址，导航搜厂名即可。坐公交到最近站点后步行或骑共享单车，部分厂区有班车。',
    keywords: ['面试地点', '地址', '路线', '怎么去', '导航', '班车'],
  },
  {
    id: 'eligibility.age',
    category: 'eligibility',
    title: '年龄与学历要求',
    text: '普工类岗位一般要求 18 到 45 岁，学历不限；技术岗或餐饮岗会看经验和健康证。超龄一点点可以先发简历，我们帮你协调。',
    keywords: ['年龄', '多大', '学历', '超龄', '要求', '18'],
  },
  {
    id: 'eligibility.student',
    category: 'eligibility',
    title: '学生工与暑假工',
    text: '满 16 周岁的学生可以做暑假工，需要学生证或在读证明，不能安排夜班和加班。开学前提前 3 天说，正常结算。',
    keywords: ['学生', '暑假工', '兼职', '16', '学生证', '开学'],
  },
  {
    id: 'misc.referral',
    category: 'platform',
    title: '推荐朋友有奖励吗',
    text: '推荐朋友入职满一个月有奖励，一般 200 元一人，被推荐人要在登记时写你的名字和电话。',
    keywords: ['推荐', '介绍', '朋友', '奖励', '200', '内推'],
  },
];

export const CHUNK_BY_ID = new Map(POLICY_CHUNKS.map((c) => [c.id, c]));

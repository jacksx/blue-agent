// 本地假模型：OpenAI 兼容接口，用来验证「改写 / 接地校验 / 降级」整条链路。
// 不需要任何 API key，也不花钱。
//
//   node scripts/mock-llm.mjs            # 监听 8899
//   curl -X POST localhost:8899/mode -d '{"mode":"hallucinate"}'

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8899);

/** 各种"模型会犯的错"，用来证明兜底真的生效 */
const MAKERS = {
  // 正常改写：不新增数字，保留问句
  good: (draft) => `${draft} 有问题随时问我。`,
  // 编数字：草稿里没有 8000
  hallucinate: (draft) => `${draft} 我们最高能到 8000。`,
  // 把问句改成陈述句：该问的没问
  dropQuestion: (draft) => draft.replace(/[？?]/g, '。'),
  // 站外导流
  contact: (draft) => `${draft} 加我微信详聊。`,
};

let mode = 'good';
let flakyCount = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'POST' && url === '/mode') {
    const body = JSON.parse((await readBody(req)) || '{}');
    mode = body.mode ?? 'good';
    flakyCount = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode }));
    return;
  }

  if (req.method === 'POST' && url === '/chat/completions') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const user = payload.messages?.find((m) => m.role === 'user')?.content ?? '';
    const draft = /草稿：\n([\s\S]*?)\n\n请改写/.exec(user)?.[1] ?? '';

    if (mode === 'http500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }

    // 前两次 500，第三次正常——用来验证指数退避真的重试了
    if (mode === 'flaky') {
      flakyCount += 1;
      if (flakyCount <= 2) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'transient' } }));
        return;
      }
    }

    if (mode === 'slow') {
      await new Promise((r) => setTimeout(r, 30_000));
    }

    // 理解层要的是 JSON；这里回一个"看起来像真的"的理解结果
    if (payload.response_format?.type === 'json_object') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  action: 'ask',
                  topics: ['hiring'],
                  confidence: 0.9,
                  shift: null,
                  salaryTarget: null,
                  healthCert: null,
                  unclear: null,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 90, completion_tokens: 30 },
        }),
      );
      return;
    }

    const make = MAKERS[mode] ?? MAKERS.good;
    const content = make(draft);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 120, completion_tokens: 24 },
      }),
    );
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-llm listening on http://127.0.0.1:${PORT}  (mode=${mode})`);
});

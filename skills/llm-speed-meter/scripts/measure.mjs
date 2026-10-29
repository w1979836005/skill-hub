#!/usr/bin/env node
/**
 * llm-speed-meter — measure real streaming latency and throughput.
 *
 * Splits the ONE number dashboards show into three:
 *   TTFT   latency until the first token arrives (what humans actually feel)
 *   rate   steady-state events/sec after streaming starts (model + infra speed)
 *   jitter stdev of inter-event gaps (tells you if a gateway is batching SSE)
 *
 * Zero dependencies. Node >= 18.
 */

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';

const USAGE_TEXT = `
用法:
  node measure.mjs --base-url <url> --model <name> [options]

必需:
  --base-url <url>     接口基址，如 https://api.deepseek.com/v1
                       也可直接给完整端点 .../chat/completions 或 .../messages
  --model <name>       模型名

鉴权（优先用环境变量或 --key-file，避免 key 进 argv 和命令历史）:
  --key <key>          不建议直接写：key 会留在 shell 历史和进程列表里
  --key -              从 stdin 读取，最安全 --  printf '%s' "$K" | ... --key -
  --key-file <path>    从文件读取，测完删文件
                       否则回退到环境变量 LLM_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
  --header "k: v"      附加请求头，可重复（如 "--header 'X-Org: abc'"）

可选:
  --format <fmt>       auto | openai | anthropic   默认 auto（按 URL / 模型名推断）
  --runs <n>           正式测量轮数，默认 1，多轮取中位数
  --warmup <n>         预热轮数，不计入结果，默认 0（建议 1，排除冷启动）
  --max-tokens <n>     输出上限，默认 256（太短测不出稳态速率）
  --prompt <text>      提示词，默认让模型写一段中文说明
  --timeout <sec>      单轮超时，默认 120
  --json               只输出 JSON，便于脚本消费
  -h, --help           显示本说明

示例:
  node measure.mjs --base-url https://api.deepseek.com/v1 --model deepseek-chat \\
    --key $KEY --runs 3 --warmup 1
`;

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = {
    baseUrl: process.env.LLM_BASE_URL || '',
    model: process.env.LLM_MODEL || '',
    key: '',
    keyFile: '',
    keyFromStdin: false,
    keyFromArgv: false,
    format: 'auto',
    runs: 1,
    warmup: 0,
    maxTokens: 256,
    prompt: '请用中文写一段约 150 字的说明，主题是流式接口的响应速度如何影响使用体验。',
    timeout: 120,
    json: false,
    headers: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '-h':
      case '--help':
        console.log(USAGE_TEXT);
        process.exit(0);
        break;
      case '--base-url':
        o.baseUrl = next();
        break;
      case '--model':
        o.model = next();
        break;
      case '--key': {
        const v = next();
        if (v === '-') {
          o.keyFromStdin = true;
        } else {
          o.key = v;
          o.keyFromArgv = true;
        }
        break;
      }
      case '--key-file':
        o.keyFile = next();
        break;
      case '--format':
        o.format = next();
        break;
      case '--runs':
        o.runs = Number(next());
        break;
      case '--warmup':
        o.warmup = Number(next());
        break;
      case '--max-tokens':
        o.maxTokens = Number(next());
        break;
      case '--prompt':
        o.prompt = next();
        break;
      case '--timeout':
        o.timeout = Number(next());
        break;
      case '--header':
        o.headers.push(next());
        break;
      case '--json':
        o.json = true;
        break;
      default:
        die(`未知参数 ${a}（用 -h 查看用法）`);
    }
  }

  if (!o.baseUrl) die('缺少 --base-url');
  if (!o.model) die('缺少 --model');

  if (o.keyFromStdin) {
    try {
      o.key = fs.readFileSync(0, 'utf8').trim();
    } catch (err) {
      die(`从 stdin 读取 key 失败: ${err.message}`);
    }
  } else if (o.keyFile) {
    try {
      o.key = fs.readFileSync(o.keyFile, 'utf8').trim();
    } catch (err) {
      die(`读取 --key-file 失败: ${err.message}`);
    }
  } else if (!o.key) {
    o.key =
      process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  }

  // The key must never end up in a transcript, a log, or a chat history.
  if (o.keyFromArgv && !o.json) {
    process.stderr.write(
      '警告: 通过 --key 传入 key 会留在 shell 历史和进程列表里。' +
        '建议改用 --key -（stdin）或 --key-file，测完在服务商后台吊销。\n'
    );
  }
  if (!Number.isFinite(o.runs) || o.runs < 1) die('--runs 必须是 >= 1 的整数');
  if (!Number.isFinite(o.warmup) || o.warmup < 0) die('--warmup 必须是 >= 0 的整数');
  if (!['auto', 'openai', 'anthropic'].includes(o.format)) die('--format 只能是 auto|openai|anthropic');

  return o;
}

function resolveFormat(o, base) {
  if (o.format !== 'auto') return o.format;
  if (/\/messages$/.test(base)) return 'anthropic';
  if (/\/chat\/completions$/.test(base)) return 'openai';
  if (/^claude/i.test(o.model)) return 'anthropic';
  return 'openai';
}

function resolveEndpoint(o) {
  const base = o.baseUrl.replace(/\/+$/, '');
  const format = resolveFormat(o, base);
  const alreadyFull = /\/(messages|chat\/completions)$/.test(base);
  const path = format === 'anthropic' ? '/messages' : '/chat/completions';
  return { url: alreadyFull ? base : base + path, format };
}

function buildHeaders(o, format) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (format === 'anthropic') {
    if (o.key) headers['x-api-key'] = o.key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (o.key) {
    headers.authorization = `Bearer ${o.key}`;
  }
  for (const raw of o.headers) {
    const idx = raw.indexOf(':');
    if (idx === -1) die(`--header 应形如 "Name: value"，收到 ${raw}`);
    headers[raw.slice(0, idx).trim().toLowerCase()] = raw.slice(idx + 1).trim();
  }
  return headers;
}

function buildBody(o, format, includeUsage) {
  const body = {
    model: o.model,
    stream: true,
    max_tokens: o.maxTokens,
    messages: [{ role: 'user', content: o.prompt }],
  };
  // Some gateways reject unknown fields, so this is opt-out-able.
  if (format === 'openai' && includeUsage) body.stream_options = { include_usage: true };
  return body;
}

/** Pull the text delta (and any usage report) out of one SSE event payload. */
function readEvent(payload) {
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }

  // Anthropic: content_block_delta / message_delta
  if (obj.type === 'content_block_delta') {
    if (obj.delta?.type === 'thinking_delta' && typeof obj.delta.thinking === 'string') {
      return { reasoning: obj.delta.thinking };
    }
    const text = obj.delta?.text ?? obj.delta?.partial_json ?? '';
    return { text: typeof text === 'string' ? text : '' };
  }
  if (obj.type === 'message_delta' && obj.usage) {
    return { usage: { completionTokens: obj.usage.output_tokens } };
  }
  if (obj.type === 'message_start' && obj.message?.usage) {
    return { usage: { promptTokens: obj.message.usage.input_tokens } };
  }

  // OpenAI: choices[0].delta.content, plus reasoning_content on reasoning models
  if (Array.isArray(obj.choices)) {
    const delta = obj.choices[0]?.delta;
    const out = {};
    if (typeof delta?.content === 'string' && delta.content) out.text = delta.content;
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
    if (obj.usage) {
      out.usage = {
        completionTokens: obj.usage.completion_tokens,
        promptTokens: obj.usage.prompt_tokens,
      };
    }
    return out;
  }

  if (obj.usage) {
    return {
      usage: {
        completionTokens: obj.usage.completion_tokens,
        promptTokens: obj.usage.prompt_tokens,
      },
    };
  }
  return null;
}

async function once(o, { includeUsage = true } = {}) {
  const { url, format } = resolveEndpoint(o);
  const headers = buildHeaders(o, format);
  const body = buildBody(o, format, includeUsage);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeout * 1000);

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') die(`请求超时（${o.timeout}s）`);
    die(`请求失败: ${err.message}`);
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 400);
    clearTimeout(timer);
    // Retry once without stream_options — plenty of proxies choke on it.
    if (res.status === 400 && includeUsage && format === 'openai') {
      return { retriedWithoutUsage: true, error: text };
    }
    die(`HTTP ${res.status} ${res.statusText}\n${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const marks = []; // every delta (reasoning + content), used for the combined rate
  const contentMarks = []; // visible answer only
  const reasoningMarks = []; // thinking only
  let buf = '';
  let chars = 0;
  let reasoningChars = 0;
  let usage = null;
  let textPreview = '';

  const eat = (rawChunk) => {
    const t = performance.now();
    for (const line of rawChunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const ev = readEvent(payload);
      if (!ev) continue;
      if (ev.usage) {
        usage = { ...usage, ...Object.fromEntries(Object.entries(ev.usage).filter(([, v]) => v != null)) };
      }
      if (ev.reasoning) {
        reasoningChars += ev.reasoning.length;
        reasoningMarks.push(t);
        marks.push({ t, chars });
      }
      if (ev.text) {
        chars += ev.text.length;
        if (textPreview.length < 60) textPreview += ev.text;
        contentMarks.push(t);
        marks.push({ t, chars });
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        eat(raw);
      }
    }
    if (buf.trim()) eat(buf);
  } catch (err) {
    if (err.name === 'AbortError') die(`读取流超时（${o.timeout}s）`);
    die(`读取流失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const endAt = performance.now();

  if (marks.length === 0) die(`没有收到任何文本增量（format=${format}, url=${url}）`);

  const firstAt = marks[0].t;
  const lastAt = marks[marks.length - 1].t;
  const ttftMs = firstAt - t0;
  const streamMs = lastAt - firstAt;
  const wallMs = endAt - t0;
  const n = marks.length;

  const spanRate = (arr) =>
    arr.length > 1 ? ((arr.length - 1) / (arr[arr.length - 1] - arr[0])) * 1000 : 0;

  const intervals = [];
  for (let i = 1; i < n; i++) intervals.push(marks[i].t - marks[i - 1].t);
  const meanInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
  const variance = intervals.length
    ? intervals.reduce((a, b) => a + (b - meanInterval) ** 2, 0) / intervals.length
    : 0;
  const pct = (q) => {
    if (!intervals.length) return 0;
    const s = [...intervals].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  };

  return {
    endpoint: url,
    format,
    ttftMs,
    wallMs,
    streamMs,
    events: n,
    chars,
    // events/sec after the first byte: the closest thing to "model speed"
    steadyRate: streamMs > 0 ? ((n - 1) / streamMs) * 1000 : 0,
    // split reasoning from visible answer so reasoning models stay comparable
    contentRate: spanRate(contentMarks),
    reasoningRate: spanRate(reasoningMarks),
    contentEvents: contentMarks.length,
    reasoningEvents: reasoningMarks.length,
    reasoningChars,
    // exact number when the provider reports usage (includes prefill-free accounting)
    usageRate: usage?.completionTokens ? (usage.completionTokens / streamMs) * 1000 : null,
    completionTokens: usage?.completionTokens ?? null,
    promptTokens: usage?.promptTokens ?? null,
    charsPerSec: (chars / wallMs) * 1000,    // the number that exposes gateway batching
    jitterMs: Math.sqrt(variance),
    intervalP50Ms: pct(0.5),
    intervalP95Ms: pct(0.95),
    intervalMaxMs: intervals.length ? Math.max(...intervals) : 0,
    preview: textPreview,
  };
}

async function measure(o) {
  const runs = [];
  let includeUsage = true;

  // Some gateways reject stream_options; downgrade once and stick with it.
  const call = async () => {
    let r = await once(o, { includeUsage });
    if (r.retriedWithoutUsage) {
      includeUsage = false;
      r = await once(o, { includeUsage: false });
    }
    return r;
  };

  for (let i = 0; i < o.warmup; i++) {
    if (!o.json) process.stderr.write(`预热 ${i + 1}/${o.warmup} ...\n`);
    await call();
  }

  for (let i = 0; i < o.runs; i++) {
    if (!o.json) process.stderr.write(`测量 ${i + 1}/${o.runs} ...\n`);
    runs.push(await call());
  }
  return runs;
}

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');

function summarize(runs) {
  const pick = (k) => runs.map((r) => r[k]).filter((v) => v != null && Number.isFinite(v));
  return {
    runs: runs.length,
    ttftMs: median(pick('ttftMs')),
    steadyRate: median(pick('steadyRate')),
    usageRate: median(pick('usageRate')),
    wallMs: median(pick('wallMs')),
    jitterMs: median(pick('jitterMs')),
    intervalP50Ms: median(pick('intervalP50Ms')),
    intervalP95Ms: median(pick('intervalP95Ms')),
    charsPerSec: median(pick('charsPerSec')),
    completionTokens: median(pick('completionTokens')),
    events: median(pick('events')),
    contentRate: median(pick('contentRate')),
    reasoningRate: median(pick('reasoningRate')),
    contentEvents: median(pick('contentEvents')),
    reasoningEvents: median(pick('reasoningEvents')),
  };
}

function printHuman(summary, runs) {
  console.log('');
  console.log('=== llm-speed-meter ===');
  console.log(`endpoint : ${runs[0].endpoint}`);
  console.log(`format   : ${runs[0].format}`);
  console.log('');
  console.log('指标                     值          含义');
  console.log('-----------------------  ----------  ----------------------------------');
  console.log(
    `TTFT                     ${f(summary.ttftMs, 0).padStart(8)} ms  首字延迟（体感快慢主要看这个）`
  );
  console.log(
    `稳态速率                 ${f(summary.steadyRate, 1).padStart(8)} ev/s 流开始后每秒增量事件数`
  );
  if (summary.usageRate != null) {
    console.log(
      `  └ 按 usage 折算          ${f(summary.usageRate, 1).padStart(8)} tok/s 服务端上报的 completion_tokens`
    );
  }
  if (summary.reasoningEvents > 0) {
    console.log(
      `  └ 思考部分               ${f(summary.reasoningRate, 1).padStart(8)} ev/s ${f(summary.reasoningEvents, 0)} 个事件（推理模型专有，不计入正文）`
    );
    console.log(
      `  └ 正文部分               ${f(summary.contentRate, 1).padStart(8)} ev/s ${f(summary.contentEvents, 0)} 个事件`
    );
  }
  console.log(
    `字符吞吐                 ${f(summary.charsPerSec, 1).padStart(8)} ch/s 端到端（含 TTFT）`
  );
  console.log(`总耗时                   ${f(summary.wallMs, 0).padStart(8)} ms  从发请求到流结束`);
  console.log('');
  console.log(
    `chunk 间隔抖动            ${f(summary.jitterMs, 1).padStart(8)} ms  标准差 -> 高=网关在攒批`
  );
  console.log(`  └ p50 / p95            ${f(summary.intervalP50Ms, 0).padStart(5)} / ${f(summary.intervalP95Ms, 0).padStart(5)} ms`);
  console.log('');
  if (runs.length > 1) {
    console.log('逐轮明细:');
    runs.forEach((r, i) => {
      console.log(
        `  #${i + 1}  TTFT ${f(r.ttftMs, 0).padStart(6)}ms  ` +
          `${f(r.steadyRate, 1).padStart(6)} ev/s  ` +
          `抖动 ${f(r.jitterMs, 1).padStart(6)}ms  ` +
          `耗时 ${f(r.wallMs, 0).padStart(6)}ms`
      );
    });
    console.log('');
  }
  console.log('解读:');
  const meanInterval = summary.steadyRate > 0 ? 1000 / summary.steadyRate : 0;
  const ratio = meanInterval > 0 ? summary.intervalP95Ms / meanInterval : 0;

  if (summary.ttftMs > 1500) {
    console.log('  · TTFT 偏高 -> 是 prefill / 排队 / 网关鉴权在拖，不是输出速度问题。');
  }

  // Batching needs an absolute threshold: at high throughput several events land in one
  // TCP packet, which produces 0ms gaps without any proxy buffering involved.
  if (summary.intervalP95Ms >= 60 && ratio >= 3) {
    console.log('  · 攒批：p95 间隔既大（>=60ms）又远高于平均（>=3x）-> 有东西在缓冲后整批下发。');
    console.log('    平均值骗人：速率看着正常，体验却是一卡一卡。查代理的 proxy_buffering / gzip / 中间层聚合。');
  } else if (summary.intervalP95Ms < 40 || ratio <= 2.5) {
    console.log('  · 流式链路健康：间隔分布紧凑，没有可感知的攒批。');
  } else {
    console.log('  · 间隔轻微不匀，但还没到可感知攒批的程度。');
  }

  if (summary.intervalP50Ms === 0 && summary.steadyRate > 50) {
    console.log('  · p50=0ms 属正常：吞吐高时多个事件常挤在同一个 TCP 包里，不等于攒批。');
  }
  if (summary.steadyRate && summary.ttftMs / 1000 > 0) {
    const tps = summary.steadyRate;
    console.log(`  · 纯推理侧大约 ${f(tps, 0)} ev/s，这个数才适合跨模型横向比。`);
  }
  console.log('');
}

const opts = parseArgs(process.argv.slice(2));

// Say it BEFORE the run too: if the measurement crashes or is interrupted, the closing
// checklist never prints, and the key would be forgotten exactly when it matters most.
if (opts.key && !opts.json) {
  process.stderr.write(
    '\n⚠ 本轮用的是真实密钥。测完必须到 API 开放平台把这枚 key 删除/吊销，\n' +
      '  本地删文件、unset、清历史都不算销毁 —— 只有服务商能让它失效。\n\n'
  );
}

const runs = await measure(opts);
const summary = summarize(runs);

if (opts.json) {
  console.log(JSON.stringify({ summary, runs }, null, 2));
} else {
  printHuman(summary, runs);
}

// Mandatory cleanup reminder. Local deletion is NOT destruction: a key that was ever
// exposed has to be revoked server-side before it stops being a liability.
if (opts.key && !opts.json) {
  console.log('════════════════════════════════════════════════════════════');
  console.log('测完了 —— 现在就去删这枚 key（必做，不是建议）');
  console.log('════════════════════════════════════════════════════════════');
  if (opts.keyFromStdin) console.log('  1. 输入 key 的终端里执行: unset K  （若用了变量名）');
  if (opts.keyFile) console.log(`  1. 删除临时密钥文件: rm -f ${opts.keyFile}`);
  if (opts.keyFromArgv) {
    console.log('  1. 清 shell 历史里的明文 key（你用了 --key，key 已进历史）');
    console.log('     bash: history -c   或  编辑 ~/.bash_history 删除该行');
  }
  console.log('  2. 清当前会话环境变量: unset LLM_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY');
  console.log('  3. 【最重要】打开 API 开放平台 -> API Keys 页面，把这枚测试 key 删除/吊销。');
  console.log('     这才是真正意义上的销毁；本地动作只是扫尾。不要因为它“好像没人看见”就留着。');
  console.log('  4. 确认没被提交进仓库: node scripts/scan-secrets.mjs .');
  console.log('');
}

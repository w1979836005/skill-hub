# skill-hub

个人技能库。一个技能一个文件夹，按 [Agent Skills 规范](https://agentskills.io/specification) 组织。

```bash
pi install git:github.com/w1979836005/skill-hub   # 装进 pi（推荐）
pi install ./skill-hub                            # 本地开发，改完立即生效
```

---

## 技能目录

| 技能 | 一句话 | 依赖 |
|---|---|---|
| [`llm-speed-meter`](#llm-speed-meter) | 把一个含糊的 "tok/s" 拆成 TTFT / 稳态吞吐 / chunk 抖动，判断慢在哪 | Node ≥ 18，零依赖 |

<!-- 新增技能时在这张表加一行，并在下方补一个同名的二级标题章节 -->

---

## llm-speed-meter

> 仪表盘只给你一个 `tok/s`。这个技能把它拆成三个互相独立的数：**TTFT**（体感快慢主要看它）、
> **稳态速率**（唯一适合跨模型比的数）、**chunk 抖动**（网关有没有在攒批）。

### 什么时候用它

- 比较同一个模型的两个入口：官方 API vs 公司网关、改代理前 vs 改代理后
- 有人说「X 比 Y 快」，用数字结束争论，而不是靠体感
- 接口变慢，要判断是排队/prefill 的问题，还是模型本身就慢
- 输出是一坨一坨蹦出来的，而不是平滑流出

### 什么时候别用它

- 只想确认接口活着 —— 一个 `curl` 就够了，别浪费一次完整推理
- 想做模型能力评测 —— 这个技能只测速度，不测质量

### 怎么用

```bash
cd skills/llm-speed-meter

# 推荐：key 走 stdin，不进 argv、不进 shell 历史
printf '%s' "$LLM_API_KEY" | node scripts/measure.mjs \
  --base-url https://api.deepseek.com \
  --model deepseek-flash \
  --key - \
  --runs 3 --warmup 1
```

`--base-url` 给基址（`.../v1`）或完整端点（`.../chat/completions`、`.../messages`）都行。
协议按 URL 和模型名自动推断，也可以 `--format openai|anthropic` 显式指定。

关键参数只有三个：

| 参数 | 怎么设 |
|---|---|
| `--runs` | **≥ 3**。单轮波动能到 2 倍，只跑一次得出的结论没意义 |
| `--warmup` | **1**。第一轮含连接建立和冷启动，丢掉 |
| `--max-tokens` | **≥ 200**。太短就没有稳态可言，测的是 TCP 建连速度不是推理速度 |

完整参数：`node scripts/measure.mjs -h`

### 结果怎么读

三个数要**分开读再组合**：

| 现象 | 结论 |
|---|---|
| TTFT 高（> 1.5s），稳态速率正常 | 不是模型问题。是 prefill 太长、排队、鉴权往返或代理在请求侧干了活 |
| 稳态速率低 | 真的慢。限流降级、共享容量、或上游路由到了慢实例 |
| p95 间隔 ≥ 60ms **且** ≥ 平均间隔 3 倍 | 网关攒批。速率看着正常，体验是一卡一卡 |
| 稳态速率比面板数字高 | 面板按「总 token ÷ 总耗时」算，把 TTFT 摊进分母了，系统性偏低 |

判读规则在 `scripts/measure.mjs` 里也会自动打印在「解读」段。

### 使用注意事项

**1. key 的生命周期（最重要）**

- 传法优先级：`--key -`（stdin）> `--key-file` > 环境变量 >> `--key 明文`
  （明文会留在 argv、shell 历史和 `ps` 输出里，工具会警告）
- **测完必须到 API 开放平台的 API Keys 页面删除/吊销这枚 key。**
  本地删文件、`unset`、清历史**都不算销毁** —— 只有服务商能让它失效。
- 动手前先跑一遍 `node scripts/scan-secrets.mjs .`，确认没被提交进仓库（命中则 exit 1，可做 pre-commit hook）

**2. 别拿生产 key 做基准测试** —— 单独开一枚一次性的，测完吊销。循环跑很容易超额，而泄露的 key 比任何数字都严重。

**3. 测量的公平性**

- 同机器、同网络、同 `--max-tokens`、同提示词
- 两个入口交替跑（A、B、A、B），别让瞬时负载全砸在一边
- 从**用户所在的那台机器**测。在你笔记本上跑的结论，跟另一个地域的用户体验无关

**4. 单位陷阱**

`ev/s` 是每秒 SSE 增量事件数，不是模型 token 数 —— 一个事件可能带多个 token，一个 token 也可能被拆开。
同族 tokenizer 之间横向比没问题；跨 tokenizer 比 `charsPerSec` 是无效的（中文每字消耗的 token 数明显不同）。
服务商上报 `usage` 时会额外打印 exact 的 `tok/s`，引用数字优先用它。

**5. 推理模型要分开比**

会流 `reasoning_content` 的模型（DeepSeek V4 Pro、o 系列、Claude thinking）先思考再回答。
技能会分别打印 `思考部分` / `正文部分` 的速率。

- **正文比正文，绝不总量比总量**
- `--max-tokens` 同时限制思考和正文，限太紧会导致思考把预算吃光、正文被截断

**6. 计费** —— N 轮就是 N 次完整推理，别对着生产环境死循环跑。

### 踩过的坑（都是实测出来的，不是推演）

- **`p50 = 0ms` 不等于攒批。** 高吞吐时多个 SSE 事件挤在同一个 TCP 包里，间隔天然是 0ms。
  早期的判定用「抖动 > p50」，在一条 133 tok/s 的健康链路上误报了攒批。
  现在的规则改成绝对 + 相对双阈值：p95 ≥ 60ms **且** ≥ 平均间隔 3 倍。
- **不做思考/正文拆分，等于拿思考速度比直答速度。** V4 Pro 实测思考 99 个事件、正文 113 个，
  不分段的话横比完全没有意义。
- **部分网关拒绝 `stream_options`。** 脚本检测到 400 会自动去掉该字段重试一次。
  如果输出里没有 `tok/s` 行，说明发生了这次降级，此时 `ev/s` 仍然有效。

### 自测（不花一分钱）

想验证工具本身准不准，或怀疑结果不可能，用内置 mock 服务器：

```bash
node scripts/mock-sse.mjs &                    # 127.0.0.1:18080
node scripts/measure.mjs --base-url http://127.0.0.1:18080/v1 --model t --runs 2 --warmup 1
node scripts/measure.mjs --base-url http://127.0.0.1:18080/batch/v1 --model t
```

第一条应判「流式链路健康」，第二条（`batch` 模拟缓冲代理）应判「攒批」。判定反了说明工具或环境有问题。

收尾记得关掉 mock：`netstat -ano | grep 18080` 找到 PID，再 `taskkill //PID <pid> //F`。

---

## 新增技能

每个技能一个文件夹：

```
skills/
└── <skill-name>/
    ├── SKILL.md      # 必须。frontmatter 的 name + description 决定何时被加载
    ├── scripts/      # 可选。可执行脚本，优先零依赖
    ├── references/   # 可选。按需读取的详细文档
    └── assets/       # 可选。模板等静态资源
```

约定：

- 目录名 = `SKILL.md` 里的 `name`，小写字母/数字/连字符，≤ 64 字符
- `description` ≤ 1024 字符，必须同时写清「做什么」和「什么时候用」—— 模型只靠这一句决定是否加载
  （写 "Helps with PDFs" 等于没写）
- 脚本从技能目录用相对路径引用，优先零依赖
- 写完 `/reload`，用 `/skill:<name>` 验证

新增后要同步三处：上方「技能目录」表格加一行、下方加一个同名章节、`package.json` 不需要改
（`files: ["skills/"]` 已覆盖）。

## 发布到 npm

当前 registry 是镜像源（只读），发不出去。第一次发布前：

```bash
npm login
npm publish --registry https://registry.npmjs.org
```

`skill-hub` 这个名字大概率已被占用，发布时改成带 scope 的 `@<你的npm用户名>/skill-hub`，
并保持 `publishConfig.access: public`，否则 scoped 包默认私有，会报 402。

## License

MIT — 见 [LICENSE](LICENSE)。

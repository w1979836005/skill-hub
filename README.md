# skill-hub

个人技能库。一个技能一个文件夹，按 [Agent Skills 规范](https://agentskills.io/specification) 组织。

```bash
pi install git:github.com/w1979836005/skill-hub   # 装进 pi
```

## 技能目录

| 技能 | 一句话 | 依赖 |
|---|---|---|
| [`llm-speed-meter`](#llm-speed-meter) | 把含糊的 tok/s 拆成 TTFT / 稳态速率 / chunk 抖动 | Node ≥ 18，零依赖 |
| [`windows-intranet-service-deploy`](#windows-intranet-service-deploy) | Windows 内网部署：uvicorn + NSSM 开机自启 + 防火墙 + 验证 | PowerShell 5.1+，NSSM（脚本可自动下载） |

## llm-speed-meter

仪表盘只给一个 `tok/s`。这个技能拆成三个独立的数：**TTFT**（体感快慢主要看它）、
**稳态速率**（唯一适合跨模型横比的数）、**chunk 抖动**（网关有没有在攒批）。

**用它**：比较同一模型的两个入口 · 判断变慢是排队还是模型本身慢 · 输出一坨一坨蹦
**别用**：只想确认接口活着（`curl` 够了）· 模型能力评测

```bash
cd skills/llm-speed-meter
printf '%s' "$KEY" | node scripts/measure.mjs \
  --base-url https://api.deepseek.com --model deepseek-flash --key - \
  --runs 3 --warmup 1
```

三个参数不能省：`--runs ≥ 3`（单轮波动可达 2 倍）、`--warmup 1`（丢掉冷启动）、
`--max-tokens ≥ 200`（太短就没有稳态可测）。

| 现象 | 结论 |
|---|---|
| TTFT 高、稳态速率正常 | prefill 太长 / 排队 / 鉴权往返，不是模型慢 |
| 稳态速率低 | 真的慢：限流降级或路由到了慢实例 |
| p95 ≥ 60ms 且 ≥ 平均间隔 3 倍 | 网关攒批，速率看着正常但体验是一卡一卡 |
| 稳态速率高于面板数字 | 面板把 TTFT 摊进了分母，系统性偏低 |

⚠️ **测完到 API 开放平台删除/吊销那枚 key。** 本地删文件、`unset`、清历史都不算销毁 ——
只有服务商能让它失效。key 走 `--key -`（stdin）或 `--key-file`，别用 `--key 明文`（会进 argv 和 shell 历史）。
提交前跑 `node scripts/scan-secrets.mjs .` 确认没被写进仓库。

推理模型（V4 Pro / o 系列 / Claude thinking）会分别输出 `思考` 和 `正文` 两段速率：
**正文比正文，绝不总量比总量**，否则等于拿思考速度去比直答速度。

参数全集、单位陷阱、实测踩过的坑 → [SKILL.md](skills/llm-speed-meter/SKILL.md)

## windows-intranet-service-deploy

把 Windows 上的 Python/FastAPI 服务变成内网可访问、开机自启的 Windows 服务。
覆盖：前台自测 → 防火墙 → NSSM 下载/注册 → 健康检查 → 内网验证 → 日志/升级/卸载/排障。

**用它**：服务只能本机访问 · 重启电脑后服务不会自己起来 · 需要 NSSM + 防火墙一套流程
**别用**：只临时跑一次、不需要内网访问和开机自启

```powershell
# 管理员 PowerShell
cd skills/windows-intranet-service-deploy/scripts

.\install-service.ps1 `
  -ProjectDir "E:\bug-report" `
  -ServiceName "BugReport" `
  -Port 8000 `
  -ForceReinstall

.\verify.ps1 `
  -ProjectDir "E:\bug-report" `
  -ServiceName "BugReport" `
  -Port 8000
```

关键约束：`--workers 1`（SQLite / 内存 token / 内存锁不能多 worker）；NSSM 默认 `LocalSystem`，
没有当前用户的代理环境变量；启停服务需要管理员 PowerShell；`TIME_WAIT` 不是监听。

完整流程、手动命令、排障表 → [SKILL.md](skills/windows-intranet-service-deploy/SKILL.md)

BugReport 实际部署记录 → [references/bugreport.md](skills/windows-intranet-service-deploy/references/bugreport.md)

## 新增技能

```
skills/<skill-name>/
├── SKILL.md      # 必须。frontmatter 的 name + description 决定何时被加载
├── scripts/      # 可选。优先零依赖
├── references/   # 可选。按需读取的详细文档
└── assets/       # 可选。静态资源
```

- 目录名 = `SKILL.md` 的 `name`，小写字母/数字/连字符，≤ 64 字符
- `description` ≤ 1024 字符，必须写清「做什么 + 什么时候用」——模型只靠这一句决定是否加载
- 新增后同步两处：上方目录表加一行、下方补一个同名章节（`##`）
- `/reload` 后用 `/skill:<name>` 验证

## 发布到 npm

当前 registry 是镜像源（只读），发不出去：

```bash
npm login
npm publish --registry https://registry.npmjs.org
```

`skill-hub` 这名字大概率被占，发布时改成带 scope 的 `@<用户名>/skill-hub`，
并保持 `publishConfig.access: public`，否则 scoped 包默认私有会报 402。

## License

MIT — 见 [LICENSE](LICENSE)。

# skill-hub

个人技能库。一个技能一个文件夹，按 [Agent Skills 规范](https://agentskills.io/specification) 组织，
用 npm 分发。

## 技能列表

| 技能 | 用途 |
|---|---|
| [`llm-speed-meter`](skills/llm-speed-meter/SKILL.md) | 把一个含糊的 "tok/s" 拆成 TTFT / 稳态吞吐 / SSE 抖动，判断慢在哪 |

## 结构

```
skill-hub/
├── package.json          # keywords: pi-package，files: skills/
└── skills/
    └── <skill-name>/
        ├── SKILL.md      # 必须。frontmatter 的 name + description 决定何时被加载
        ├── scripts/      # 可选。可执行脚本，零依赖优先
        ├── references/   # 可选。按需读取的详细文档
        └── assets/       # 可选。模板等静态资源
```

新增技能的约定：

- 目录名 = `SKILL.md` 里的 `name`，小写字母/数字/连字符，≤64 字符
- `description` ≤1024 字符，必须同时写清「做什么」和「什么时候用」——模型只靠这一句决定是否加载
- 脚本从技能目录用相对路径引用，优先零依赖
- 写完后 `/reload`，用 `/skill:<name>` 验证

## 安全：测完必须销毁 key

用真实 key 跑测量前后，技能会强制提醒，但**本地删除不等于销毁**：

1. 删掉临时 key 文件、`unset`、清 shell 历史
2. **打开 API 开放平台的 API Keys 页面，把这枚 key 删除/吊销** —— 只有服务商能让它失效
3. `node skills/llm-speed-meter/scripts/scan-secrets.mjs .` 确认没被提交进仓库

优先用 `--key -`（stdin）或 `--key-file` 传 key，避免它进 argv 和命令历史。

## 安装

```bash
# 本地开发（改完立即生效）
pi install ./skill-hub

# 从 git
pi install git:github.com/<you>/skill-hub

# 从 npm（发布后）
pi install npm:@<scope>/skill-hub
```

也可以手动拷到 `~/.agents/skills/` 或项目的 `.agents/skills/`。

## 发布

当前 `package.json` 的 registry 是镜像源，发不出去。第一次发布前：

```bash
npm login
npm publish --registry https://registry.npmjs.org
```

`skill-hub` 这个名字大概率已被占用，发布时改成带 scope 的：`@<你的npm用户名>/skill-hub`，
同时保持 `publishConfig.access: public`，否则 scoped 包默认私有会报 402。

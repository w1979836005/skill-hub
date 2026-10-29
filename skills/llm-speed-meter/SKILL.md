---
name: llm-speed-meter
description: Measure the real streaming speed of an LLM endpoint, splitting the single "tok/s" number dashboards report into TTFT, steady-state throughput, and inter-chunk jitter. Use when comparing providers, gateways, proxies, or models by speed; when an endpoint "feels slow" or "feels fast" and you need numbers instead of impressions; or when diagnosing whether latency comes from queueing/prefill or from the model itself.
license: MIT
compatibility: Requires Node.js >= 18. No dependencies, no install step. Works on Windows Git Bash, macOS, and Linux.
---

# LLM Speed Meter

Splits one ambiguous number into three measurements that answer different questions.

| Metric | Question it answers |
|---|---|
| **TTFT** (time to first token) | How long the user stares at a blank screen. Dominates perceived speed. |
| **Steady rate** (ev/s or tok/s) | How fast text arrives once it starts. The only metric comparable across models. |
| **Jitter** (stdev of inter-chunk gaps) | Is a gateway buffering/batching the SSE stream? |

Averaging all three into one "tokens/sec" figure — what most dashboards do — hides exactly the
failure modes people complain about.

## When to use

- Comparing two endpoints serving the same model (official API vs company gateway, before/after a proxy change).
- Someone says "X feels faster than Y" — measure instead of arguing.
- An endpoint is slow and you must decide: is it queueing/queue depth (high TTFT) or a slow model (low steady rate)?
- Output arrives in visible bursts rather than smoothly.

Skip it when you only need a rough sanity check on whether an endpoint is alive — a single curl is enough.

## Run it

Zero dependencies. The script lives next to this file; resolve paths relative to the skill directory.

```bash
node scripts/measure.mjs \
  --base-url https://api.deepseek.com/v1 \
  --model deepseek-chat \
  --key "$API_KEY" \
  --runs 3 --warmup 1
```

Useful flags:

| Flag | Default | Notes |
|---|---|---|
| `--base-url` | — | Base URL (`.../v1`) or a full endpoint ending in `/chat/completions` or `/messages` |
| `--model` | — | Model name; also used to infer protocol (`claude*` → Anthropic) |
| `--key` | env | Falls back to `LLM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` |
| `--format` | `auto` | `auto` / `openai` / `anthropic` |
| `--runs` | 1 | Report the median of N runs. **Use >= 3 for any conclusion.** |
| `--warmup` | 0 | Discarded runs to absorb cold start / connection setup. **Use 1.** |
| `--max-tokens` | 256 | Keep it >= 200, otherwise there is no steady state to measure |
| `--header "k: v"` | — | Repeatable; for gateways needing extra auth/org headers |
| `--json` | off | Machine-readable output, for capturing into a report |

Prefer passing the key via environment variable — values in `--key` end up in shell history.

`--json` prints `{ summary, runs }` where `summary` holds medians and `runs` holds per-run detail.
Read fields from `summary`; do not recompute medians from `runs` by hand.

## Interpret the output

Read the three numbers **separately**, then combine:

1. **High TTFT (> ~1.5s) + healthy steady rate** → not a model problem. It is prefill size, queueing,
   auth round-trips, or a proxy doing request-side work. Growing prompt length makes this worse
   quadratically-ish, so test with the prompt you actually send in production.
2. **Low steady rate** → genuinely slow inference, or a rate limit / degraded tier / shared capacity.
3. **Batching** → p95 interval is both large in absolute terms (`>= 60ms`) *and* far above the mean
   interval (`>= 3x`). The average rate can then look fine while output arrives as visible clumps.
   Nothing about the model changed; something is accumulating chunks before flushing. Look for
   buffering proxies, nginx `proxy_buffering on`, compression, or a gateway that re-serializes events.
   **Do not judge batching from jitter or `p50` alone:** at high throughput several SSE events land in
   the same TCP packet, which yields `p50 = 0ms` on a perfectly healthy endpoint. Absolute p95 is what
   separates packet coalescing (harmless) from buffering (user-visible).
4. **Steady rate higher than the dashboard number** → the dashboard is dividing total tokens by
   total wall time, which includes TTFT and queueing. Compare like with like.

### Comparing two endpoints (do this, don't eyeball it)

1. Same model name, same `--max-tokens`, same prompt, same machine, same network.
2. `--runs 3 --warmup 1` on each, interleaved if possible (A, B, A, B) so that transient load
   does not land entirely on one side.
3. Compare `summary.ttftMs` and `summary.steadyRate` independently. If TTFT differs but steady
   rate does not, the difference is infrastructure, not the model.
4. Report both numbers with the units. A bare "faster" claim is not a measurement.

## Units and fair comparison

`ev/s` counts SSE **delta events** per second, not model tokens — one event may carry several
tokens, and one token may be split across events. It is a consistent proxy when comparing the
same tokenizer family. When the provider reports `usage`, the tool also prints a `tok/s` figure
derived from `completion_tokens`, which is exact and the better number to quote. Chinese text
costs noticeably more tokens per visible character than ASCII in most tokenizers, so never
compare `charsPerSec` across different languages or tokenizers.

## Key hygiene (mandatory — every run)

A key used for measurement is **disposable infrastructure, not configuration**. The moment it is typed
into a terminal, pasted into a chat, or passed as `--key sk-...`, treat it as already leaked:
any transcript, agent context, proxy log, or shell history that captured it is a copy you do not control.

**Getting the key in — in order of preference:**

| Method | Command | Exposure |
|---|---|---|
| stdin (best) | `printf '%s' "$K" \| node scripts/measure.mjs ... --key -` | not in argv, not in history |
| key file | `node scripts/measure.mjs ... --key-file /tmp/k` then delete the file | not in argv |
| env var | `LLM_API_KEY=... node scripts/measure.mjs ...` | not on disk, still in shell env |
| `--key <literal>` | — | **argv, shell history, `ps` output** — the tool warns when you do this |

Never put a literal key in a command that will be pasted into a chat, an issue, a ticket, or an agent
transcript. If you already did, the key is burned — go straight to revocation.

**After the last run — destroy it. Do all three, in this order:**

1. **Remove local traces.** Delete the key file, `unset LLM_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY`,
   and clear history (`history -c`, or delete the offending line from `~/.bash_history`). The tool
   prints these exact steps when a key was supplied.
2. **Revoke or delete the key on the provider's API platform (`API Keys` page). This is the actual
   destruction.** Deleting a file or unsetting a variable does not disable a key — only the provider
   can, and until then it stays valid for anyone who already has a copy. Skipping this step means the
   key was never destroyed.
3. **Verify nothing was committed:** `node scripts/scan-secrets.mjs .` must exit 0.

**Tell the human, in prose, in your final reply.** This is not optional and not satisfied by the
footer the tool prints:

> 提醒：这次测试用的 key 请到 API 开放平台（API Keys 页面）删除/吊销。本地删文件不算销毁。

State it as a direct instruction naming the platform, not as a general caution. Footers get scrolled
past; a sentence addressed to the person does not. If the run used a **long-lived production key**
(the common case when the key came from an existing config file rather than a fresh one), say that the
key was exposed during the session and must be rotated now, even if the measurement succeeded.

A benchmark key has no residual value. Revoke it even when you believe nobody else saw it — if it went
through an agent, a log, or a shared screen, you cannot prove otherwise, and the cost of a fresh key is
one dashboard click.

**If a key was exposed:** rotate first, clean up second. History scrubbing alone is insufficient.

## Reasoning models

Models that stream `reasoning_content` (DeepSeek V4 Pro, o-series, Claude with thinking) emit two
kinds of delta: thinking first, then the visible answer. The tool counts them separately and prints
`思考部分` / `正文部分`, while `steadyRate` covers both together.

**Compare 正文 to 正文, never total to total.** A reasoning model that thinks for 99 events before
answering 113 looks far slower than a flash model that answered everything directly — the difference
is the thinking budget, not throughput. `--max-tokens` also caps thinking plus answer combined, so an
aggressive limit can truncate the answer while the thinking phase already consumed the budget.

## Verify the tool itself (no API key, no cost)

If results look impossible, self-test against the bundled mock server. Emit mode gives an even
~25ms stream; `batch` mode simulates a buffering proxy.

```bash
node scripts/mock-sse.mjs &                 # serves http://127.0.0.1:18080
node scripts/measure.mjs --base-url http://127.0.0.1:18080/v1 --model t --runs 2 --warmup 1
node scripts/measure.mjs --base-url http://127.0.0.1:18080/batch/v1 --model t
```

Expected: the first reports low jitter and a healthy "间隔很均匀" verdict; the `batch` one reports
high jitter, `p50` near 0, and the batching warning. If not, the tool or the environment is lying.
Kill the mock afterwards (`netstat -ano | grep 18080`, then `taskkill //PID <pid> //F` on Windows).

## Gotchas

- **Never measure with a trailing newline-only prompt or `--max-tokens 5`** — you end up timing
  connection setup, not inference.
- **Measure from the machine that matters.** Running the script from a laptop says nothing about
  what users in another region experience.
- Some gateways reject `stream_options`; the script detects the 400 and retries once without it
  automatically. If `tok/s` is missing from the output, that fallback happened — `ev/s` is still valid.
- **Never reuse a long-lived production key for benchmarking.** Mint a throwaway one, then revoke it —
  see *Key hygiene* above. Benchmark loops are easy to over-run, and a leaked key is a bigger incident
  than any number this tool reports.
- Do not run this against production in a loop; N runs is N full completions billed to you.

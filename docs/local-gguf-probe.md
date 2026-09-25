# 本地 GGUF 兜底探针（未训练 sub-1B + llama.cpp 首 token logprob）——**负结果**

**问题**：能不能「零训练、零 Python、零额外权重」，只用一个**未训练**的 sub-1B GGUF 加
llama.cpp 的「首 token 选项标签 logprob」读法，把本 skill 的 `POST /v1/systemone`
（`noul` / `choice` / `score`）答出来，作为可随 skill 分发的本地兜底？

**裁定：不能（NO）。** 机制通路全部成立（HTTP 契约、标签单 token 校验、延迟都在可接受范围），
但两个候选模型的答案等于或**低于**「永远选第一个选项」的平凡策略，且所有行为证据都指向同一个结论：
它们没有在读选项内容。

| 决定性证据 | 数字 |
|---|---|
| 0.6B 总准确率 vs 平凡基线 | **11/20 = 0.55** vs 基线 **11/20 = 0.55**（同分；两者在 16/20 题上答案相同） |
| 0.8B 总准确率 vs 平凡基线 | **10/20 = 0.50**（低于基线；两者只在 13/20 题上相同，偏差 2 次对、5 次错） |
| 选项轮转（正确选项被移走） | 16 次轮转只有 4 次「对」，且都是正确内容恰好落在它偏好的槽位；被选中的标签始终落在前 1–6 个槽位 |
| `noul` 问题 | 退化为恒定回答 `true`（p ≈ 0.987–0.9998，5/5 次），与「恒答 true」基线同分 |
| 置信度可用性 | 0.6B 错答均值 0.700 vs 全量 0.766；0.8B 0.373 vs 0.383 —— 无区分度，不能当弃权阈值 |

阻塞点在**模型**（未训练 base 不具备「读选项表做分类」的能力），不在适配层：
适配层把 Jev 响应的形状、归一化、延迟都做对了（`normalizeAnswers` **27/27** 通过、
标签概率质量 0.9936–0.9999、冷/热一步 1.7–5.1 s）。**「零下载 / 零 Python」这条路本身不成立**，
本地兜底要走有训练头的路线（Kev，见 `docs/local-kev-bringup.md`）。

> 本文件只覆盖「未训练 GGUF + 首 token 读出」这条探针；模型选型背景见 `docs/local-models-research.md`。
> 实验代码与全部原始输出保留在 `experiments/gguf-provider/`（**不属于 skill**，是负结果证据）。

---

## 1. 原型做了什么

目录 `experiments/gguf-provider/`：纯 Node（无 npm 依赖、无 Python），把 llama.cpp 的
单 token 分布包装成 Jev 的 `/v1/systemone`。

| 文件 | 作用 |
|---|---|
| `lib/readout.mjs` | llama.cpp HTTP 客户端：`/tokenize`、`/apply-template`、`/completion`（`n_predict=1`、`n_probs=512`、samplers 全关）；把标签概率从分布里读出来 |
| `lib/labels.mjs` | 选项标签：`A..Z, AA, AB, …`（bijective base-26），与 openjev 一致 |
| `lib/render.mjs` | 渲染 `system + state + 选项表 + "Answer:"`；用**真实 tokenizer** 校验「标签在该表面形式下是单 token」 |
| `lib/provider.mjs` | `systemOne()`：按题读标签概率 → 组装 Jev 形状的 `answers`（含 `confidence`） |
| `serve.mjs` | `/v1/systemone` + `/v1/models` + `/health`；skill 只要 `TYPESAFE_BASE_URL` 指过来，**零改代码** |
| `eval/`、`lab/` | 20 条自明真值评测、选项轮转、契约检查、延迟、tokenizer / 结束符 / noul 先验探针 |
| `results/`、`fixtures/` | 全部原始输出与真实页面捕获（本文件每个数字都能在其中找到，见 §9） |

**读出机制**（等价于 `ekzhang/openjev-sglang` 的 prefill-only 读法，但换成 llama.cpp）：

1. 渲染：`system`（分类器人设）+ user（`state` JSON + 本题 + 带标签的选项表）+ 固定 cue（`Answer:`，
   由适配层自己持有，不依赖模型模板结尾）；
2. `/completion` 只预测 **1 个 token**，`n_probs=512`，**samplers 全部关闭**
   （`temperature=1, top_k=0, top_p=1, min_p=0, repetition/presence/frequency penalty=0`）
   → 返回的就是该位置**未经采样的 softmax 分布**（无生成、无解析、无文本后处理）；
3. 读出：把各选项的标签 token 概率取出（`" A"` 与 `"A"` 两种表面形式相加），在选项集合上归一化
   → `choice.probabilities`；`noul` 取 `true` 标签的 p；`score` 用 `Σ i·p(i)`，`confidence = 1 − H/log n`。

**被测量的两个模型**（本地既有文件，本次未新下载）：

| | 0.6B | 0.8B |
|---|---|---|
| 文件 | `/tmp/gguf/Qwen3-0.6B-Q8_0.gguf` | `~/.jev-browser/models/Qwen3.5-0.8B-Q8_0.gguf`（模型缓存目录） |
| 字节 | 639,446,688 | 811,843,840 |
| sha256 | `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031` | `0ad885ffd4bb022fc4f0d33a3308fa108ef8613159d3b3a67e23abca056b7a6c` |
| GGUF `general.name` | **Qwen3 0.6B Instruct** ⚠️ | Qwen3.5-0.8B |
| `general.architecture` | `qwen3` | `qwen35` |
| 量化 | `file_type=7`（Q8_0） | `file_type=7`（Q8_0） |
| 推理栈 | `llama-server`（Homebrew `llama.cpp` **0.4.0**，build b10809，commit 5266f24da）；macOS 默认走 Metal（启动日志出现 `common_fit_params … free device memory`，即确有 GPU 设备被选中） |

> ⚠️ 0.6B 这份量化文件是 **Instruct** 版本（`general.name = "Qwen3 0.6B Instruct"`），
> 不是 JEV-CPU / SemIf 用的 `Qwen3-0.6B-Base`；Base 未测（见 §8）。
> ⚠️ 0.6B 的 GGUF 放在 `/tmp/gguf/`，**现已不在本机**（`/tmp` 清理掉了，仓库与模型缓存里都没有副本）。
> 重跑 0.6B 这一行前要先重建它：重新下载 Qwen3-0.6B **Instruct** 的 Q8_0 量化
> （`general.name` 必须是 `Qwen3 0.6B Instruct`，不是 `Qwen3-0.6B-Base`），
> 放到任意路径后核对上表的字节数 639,446,688 与 sha256 `9465e63a…bb031`，再把 §2 命令里的 `-m` 指过去。
> 0.8B 放在 `~/.jev-browser/models/`（`jev-local` / `jev-kev` 的模型缓存目录，仍在）；
> 仓库内不再保留任何 GGUF 副本（`*.gguf` 已在 `.gitignore` 兜底）。

---

## 2. 复现命令

```bash
# 0) 推理二进制
brew install llama.cpp            # 实测 0.4.0 / build 10809

# 1) 两个 llama-server（0.6B:8090，0.8B:8091）
# 0.6B 文件已不在 /tmp/gguf/（见 §1 的重建步骤：重新下载 Instruct Q8_0 并校验 sha256 9465e63a…）
/opt/homebrew/bin/llama-server -m <重建后的 Qwen3-0.6B-Q8_0.gguf 路径> \
  --port 8090 --ctx-size 16384 --jinja --threads 8 -np 1 --no-warmup
/opt/homebrew/bin/llama-server -m ~/.jev-browser/models/Qwen3.5-0.8B-Q8_0.gguf \
  --port 8091 --ctx-size 16384 --jinja --threads 8 -np 1 --no-warmup
# --jinja 必须开（适配层用 /apply-template 走模型自带 chat 模板）；-np 1 单槽；--no-warmup 跳过启动预热

# 2) /v1/systemone 适配层（skill 侧只改 baseUrl）
node experiments/gguf-provider/serve.mjs --port 8092 --url http://127.0.0.1:8090
node experiments/gguf-provider/serve.mjs --port 8093 --url http://127.0.0.1:8091 --model qwen3.5-0.8b-q8

# 3) 端到端：真实 skill CLI（不改一行 skill 代码）
TYPESAFE_API_KEY=local TYPESAFE_BASE_URL=http://127.0.0.1:8092 \
  node skills/jev-browser/bin/jev-browser.mjs judge \
    --state-file experiments/gguf-provider/fixtures/judge-state.json \
    --questions-file experiments/gguf-provider/fixtures/judge-questions.json --json

# 4) 20 条评测 + 选项轮转（--rotate-ks / --rotate-only 是本次新增的开关）
node experiments/gguf-provider/eval/run.mjs --url http://127.0.0.1:8090 --rotate --json \
  > experiments/gguf-provider/results/eval-0.6b.json 2> experiments/gguf-provider/results/eval-0.6b.log
node experiments/gguf-provider/eval/run.mjs --url http://127.0.0.1:8091 --model qwen3.5-0.8b-q8 --rotate --json \
  > experiments/gguf-provider/results/eval-0.8b.json 2> experiments/gguf-provider/results/eval-0.8b.log
# 单题加密轮转（k=0..3，只跑轮转不跑正评）
node experiments/gguf-provider/eval/run.mjs --url http://127.0.0.1:8090 \
  --rotate --rotate-only ddg-click-target-aapl --rotate-ks 0,1,2,3 --json

# 5) 契约：provider 的响应原样喂给 skill 自己的 normalizeAnswers
node experiments/gguf-provider/lab/check-normalize.mjs --url http://127.0.0.1:8090

# 6) 真实 step 负载的延迟（16 KB state；5 问 = noul + 6 + 5 + 55 + 3 选项）
node experiments/gguf-provider/lab/latency.mjs --url http://127.0.0.1:8090

# 7) 探针
node experiments/gguf-provider/lab/tokenizer-probe.mjs      # 标签单 token 校验（128 个标签 × 3 种表面形式）
node experiments/gguf-provider/lab/probe-ending.mjs         # 三种 cue 下读出位置的真实 top 词
node experiments/gguf-provider/lab/probe-noul-bias.mjs      # 5 个 prompt 变体，判断是读状态还是读标签先验

# 8) fixtures 来源：真实 skill 的 --dry-run 捕获（fixtures/ 里 5 个真实页面都这么来的）
node skills/jev-browser/bin/jev-browser.mjs run --dry-run --json \
  --goal "find today's price of AAPL" \
  --url "https://html.duckduckgo.com/html/?q=apple+stock+price" \
  > experiments/gguf-provider/fixtures/raw_duckduckgo_com_html__q_apple_stock_price.txt
```

---

## 3. 契约兼容：通过（唯一完全通过的部分）

- `TYPESAFE_BASE_URL` 指到适配层后，**真实 skill CLI 退出码 0**、无 validation / parse 错误：
  - 0.6B：`skills/jev-browser judge` 一步 **5,104 ms**（`usage.input_tokens=5294`），
    返回 `model:"jev-latest"`、`answers{…}`、`usage`、`costUsd`（本地成本 $0）
    → `results/skill-judge-0.6b.json`
  - 0.8B：同一条命令 **2,701 ms**（`input_tokens=6877`）→ `results/skill-judge-0.8b.json`
- **provider 响应不改动**即可被 skill 自己的 `validateQuestions` + `normalizeAnswers` 消费：
  `lab/check-normalize.mjs` **27/27 PASS**（0.6B、0.8B 各跑一次：`results/check-normalize-0.6b.txt`、
  `check-normalize-0.6b-recheck.txt`、`check-normalize-0.8b.txt`），包括
  `probabilities` 键集齐全、和为 1、`ranked` 排序、`top === ranked[0][0]`、`score ∈ [0,3]`、
  `legend` 与 criteria 逐字相等。
- 标签读出质量：每题「标签概率质量」0.9936–0.9999（即标签几乎吸走全部概率）；
  所有评测行的 `multi_token_labels` 均为空（字母表校验按预期工作）。

**结论**：这条路的技术封装没有障碍 —— 问题完全在模型质量。

---

## 4. 准确率与行为证据

评测集：**20 条真值由构造保证**的题目（`eval/items.mjs`）——15 条 browser（14 条从真实
`--dry-run` 捕获的页面 state 上手工判定的决策题 + 1 条 `progress` 评分题）+ 5 条 passage 是非题（`noul`）。
每个数字可在 `results/eval-0.6b.json` / `eval-0.8b.json` 与对应 `.log` 中逐条核对。

### 4.1 总表（各 20 条）

| 集合 | Qwen3-0.6B | Qwen3.5-0.8B | 「恒选第一个选项」基线 |
|---|---|---|---|
| 全部 20 | **11/20 = 0.55**（95% CI 0.34–0.74） | **10/20 = 0.50**（0.30–0.70） | **11/20 = 0.55** |
| browser 15 | 9/15 = 0.60 | 7/15 = 0.47 | 9/15 = 0.60 |
| noul 5 | 2/5 = 0.40 | 3/5 = 0.60 | 2/5 = 0.40 |

逐问（n / 正确）：

| 问题 | n | 0.6B | 0.8B |
|---|---|---|---|
| `click_target`（55 / 100 选项） | 2 | 1 | 0 |
| `action` | 3 | 1 | 1 |
| `blocker` | 2 | 2 | 2 |
| `goal_done`（noul） | 1 | 0 | 0 |
| `type_target` | 3 | 3 | 2 |
| `submit_after_type`（noul） | 2 | 1 | 1 |
| `type_value` | 1 | 0 | 0 |
| `progress`（score） | 1 | 1 | 1 |
| `answer`（noul，passage） | 5 | 2 | 3 |

### 4.2 平凡基线：恒选第一个选项

标签按**位置**分配（`e1` = 列表里第一个元素，`true` 恒为 noul 的第一个选项），所以
「永远选第一个选项」是一个不需要读任何内容的策略。它的成绩：

- 总 **11/20 = 0.55**（browser 9/15、noul 2/5）；
- 0.6B 与它在 **16/20** 题上答案相同，仅 4 题不同（2 次对 / 2 次错）→ **总分与基线完全一致**；
- 0.8B 与它在 13/20 题上相同，7 题不同（2 次对 / 5 次错）→ **低于基线**。

即：0.6B 的 0.55「准确率」可完全由位置先验 + 噪声解释；0.8B 连这个先验都没稳定复现。

### 4.3 选项轮转：答案跟着位置走，不跟着内容走

把同一道题（`click_target`）的**选项内容整体轮转**、并同步改写 state 里的元素表与期望标签，
正确内容会落到不同标签上（如 `e54`、`e53`、`e52`、`e48`）。结果：

| 模型 | k=0 | k=1 | k=2 | k=3 | k=7 | 合计 |
|---|---|---|---|---|---|---|
| 0.6B（ddg，55 选项，want `e1`/`e54`/`e53`/`e52`/`e48`） | **e1 ✓** | e2 ✗ | e1 ✗ | e1 ✗ | e1 ✗ | 1/5 |
| 0.6B（wiki，100 选项，want `e8`/`e5`/`e1`） | e1 ✗ | — | — | e6 ✗ | **e1 ✓** | 1/3 |
| 0.8B（ddg） | e3 ✗ | e2 ✗ | e1 ✗ | e2 ✗ | e2 ✗ | 0/5 |
| 0.8B（wiki） | e4 ✗ | — | — | **e5 ✓** | **e1 ✓** | 2/3 |

- 两个模型合计 16 次轮转中只有 4 次「对」，且每次「对」都只是**正确内容恰好落在它偏好的前几个槽位**；
- 被选中的标签在两个模型上都没有离开过**前 6 个槽位**（0.6B 的全部选中标签 ∈ {e1, e2, e6}；0.8B ∈ {e1…e5}）；
- 当正确内容被轮转到 `e48`–`e54` 时，两个模型**一次都没有跟随过去**。

→ 模型读的是「第几个选项」，不是「选项写了什么」。

### 4.4 `noul` 与 prompt 表面先验

- 20 条评测里 0.6B 的 5 条 passage 是非题**全部回答 `true`**，p ∈ [0.9869, 0.9998]
  （含专门的反极性陷阱题 `bq-trap-failed`：原文说实验失败，仍答 true，p=0.9869）→ 2/5，与「恒答 true」同分。
- `lab/probe-noul-bias.mjs`（7 条是非题 × 5 个 prompt 变体）—— 换系统提示词、换少样本示例、
  把两个选项的**文字对调**（内容不变、标签互换）：

| 变体 | 正确 | 选中标签 A 的次数 | 它实际执行的不变策略 | 该常量策略的命中率 |
|---|---|---|---|---|
| v1 基线 | 3/7 | 7/7 | 恒选 A | 3/7 |
| v2 选项文字对调 | 3/7 | 2/7 | 不稳定（在两种常量间摆动） | — |
| v3 严格系统提示 | 3/7 | 7/7 | 恒选 A | 3/7 |
| v4 严格系统 + 少样本 | 4/7 | 0/7 | 恒选「NOT-STATE」 | 4/7 |
| v5 仅少样本 | 4/7 | 0/7 | 恒选「NOT-STATE」 | 4/7 |

→ 分数**等于**该变体所执行的常量策略的命中率；换 prompt 只是换了一种常量，
没有任何一个变体表现出「按 state 判断」的行为。

### 4.5 过自信：置信度不能当弃权阈值

| | 0.6B | 0.8B |
|---|---|---|
| 12 个 choice/score 答案的 mean confidence | 0.766 | 0.383 |
| 其中错答的 mean confidence | 0.700（4 个错答） | 0.373（6 个错答） |
| 最自信的错答 | **0.944**（`github-login-type-value`：把用户名题答成 `password`） | 0.797（`ddg-click-target-aapl`） |
| `noul` 最自信的错答 | 0.9969（`goal_done`，正确答案是 false） | 0.6235 |

正确/错误答案的置信度分布几乎重合（0.6B: 0.766 vs 0.700；0.8B: 0.383 vs 0.373），
**没有可用的弃权信号**：既不能靠阈值过滤错答，也不能用它触发 `wait`/人工接管。

---

## 5. 延迟（本机 M3 Max / 48 GB，llama.cpp 默认 Metal 后端，Q8_0）

评测内部统计（每题含渲染 + 读出，20 条）：

| | 0.6B | 0.8B |
|---|---|---|
| 20 条总计 / 均值 / 中位 / 最大 | 16,846 ms / 842 ms / 175 ms / **5,911 ms** | 11,133 ms / 557 ms / 130 ms / **2,927 ms** |

真实 step 负载（`fixtures/raw_duckduckgo_…`，state **16,111 B**；5 问 = `goal_done`(2 选项) +
`blocker`(6) + `action`(5) + `click_target`(**55**) + `select_target`(3)）：

| | 0.6B | 0.8B |
|---|---|---|
| 冷（首次，含字母表校验 + 全量 prefill） | 4,602 ms | 2,933 ms |
| 热（均值，2 次） | **5,031 ms** | **1,745 ms** |
| 其中 `click_target`(55 选项) | 3.44–4.13 s | 1.17–1.40 s |
| 其余 ≤6 选项的题 | 136–246 ms | 126–323 ms |
| 每步 input tokens | 5,099 | 6,877 |
| 真实 skill `judge` 调用（§3） | 5,104 ms | 2,701 ms |

- 每步耗时几乎全部来自**唯一那道 55/100 选项的题**（它的 prompt 里嵌了整个元素表，≈4.5–4.8k 新 token）；
  其余问题的读出只要 0.1–0.3 s。
- **反直觉**：更大的 0.8B 反而快 2–3×。`[INFERENCE]` 两个可能原因：Qwen3.5 的
  `qwen35` 是混合线性注意力架构（长 prompt 的 prefill 成本远低于 `qwen3` 的全注意力）；
  以及两次测量相隔约 1 小时、0.6B 服务进程已驻留且有历史负载。**这不是严格对拍**，只作量级参考。
- 横向参考（同一台机器）：有训练头的 Kev-0.8B（MLX）同规模 step 是 2.8–3.4 s 热（见 `local-kev-bringup.md`）——
  **延迟这一项 GGUF 路线没有优势**，因为瓶颈是 prompt prefill，不是生成。

---

## 6. 标签 token 化陷阱（实测，必须遵守）

读出位置读的是**某一种表面形式**的标签 token，而 Qwen 分词器对
`" AY"`（空格前缀，实际发射形式）与 `"AY"`（裸形式）**分词不同**，且例外集也不同
（`results/tokenizer-0.6b.json`，逐字核对 128 个标签 A…?）：

| 表面形式 | 单 token 数 / 128 | 不是单 token 的标签（必须跳过/特殊处理） |
|---|---|---|
| `"AY"`（裸） | 122 | `BQ` `BZ` `CJ` `CQ` `CZ` `DQ` |
| `" AY"`（空格前缀，本项目实际用） | 123 | **`AY`** `BQ` `BZ` `CQ` `DQ` |
| `"\nAY"`（换行前缀） | **0** | 全部（此形式不可用；模型也不会在这里发射 `\n`+标签） |

要点：

1. **必须在「模型实际发射的那个形式」上验证单 token**：`" AY"` 是单 token 而 `"AY"` 不是；
   反过来 `CJ`/`CZ` 裸形式会被拆开。若按裸形式建表、却读空格形式，标签概率会静默错位。
2. 同一个字母的两种形式是**不同 token**（`" A"` = id 362，`"A"` = id 32），所以读出时
   两种形式的概率**相加**（`lib/readout.mjs`），只认「在服务端 tokenizer 里确实是单 token」的那些。
3. 选项多时标签要走 `A..Z, AA..CV`（100 选项题需要 100 个标签），
   生成器必须**逐个校验、跳过被拆分者、继续向后取**（`render.mjs: verifiedAlphabet`，
   对齐 openjev 的 "verified single-token letter combinations"）——本次 20 条评测中
   `multi_token_labels` 全为空，说明该校验按预期工作。
4. 采样侧要**彻底关掉 samplers**（见 §1）并取 `n_probs=512`；即便如此，
   排不进 top-512 的低概率标签会被读成 0（0.6B 有 1 行、0.8B 有 2 行出现这种
   `missing_labels`，例如 100 选项题的 42 个尾部标签；这些行的标签质量和仍 ≥0.9936）。
   这是**尾部失真**，不影响本次结论（答案都集中在前几个槽位），但换更平的概率分布时要注意。

---

## 7. 裁定：**不能作为随 skill 分发的零 Python 本地兜底**

支持「不能」的证据（按决定性排序）：

1. **准确率 = 平凡基线**：0.6B 11/20 与基线同分且 16/20 题答案相同；0.8B 10/20 低于基线。
2. **轮转证伪「在读内容」**：正确选项被移出前几槽位后，16 次轮转里从未被跟上。
3. **`noul` 退化为常量**：恒定 `true`（p≈0.99）；prompt 变体只是换成另一种常量，
   得分恰好等于该常量的命中率。
4. **置信度无区分度**：错答照样 0.70–0.94（0.6B）、最自信的错答 p=0.9969（`goal_done`）——
   无法用阈值兜住。
5. 唯一通过的是**工程封装**：契约 27/27、标签质量 ~1.0、冷/热一步 1.7–5.1 s、成本 $0。
   也就是说：**换个有训练头的模型，这套适配层可以继续用；但未训练 sub-1B 这条路本身不成立。**

什么条件下可以翻案（都不是本次实测支持的方向）：出现「专门为读选项做过训练」的 sub-1B 权重
（= Kev 路线，但那是 Python/MLX，不是零 Python）；或换更大/指令微调模型 + 少样本 + 温度校准
（超出「sub-1B、零下载」的前提，且 0.8B 的经验说明规模不是主要变量）。

**给决定的一句话**：本地兜底请走 `docs/local-kev-bringup.md` 的 Kev 路线；
本探针保留为**负结果证据**与将来的对照基线（换模型/换量化时可用同一套 `eval/` 重跑）。

---

## 8. 未覆盖 / 边界（诚实清单）

- **样本小**：20 条自明真值 + 5 个真实页面捕获；0.6B 的 95% CI 为 0.34–0.74，不足以区分 0.5 与 0.7
  的细微差别（但足以支撑「≈基线」与「不读内容」的定性结论，后者由轮转与 noul 常量行为直接证明）。
- 只测了 **Q8_0** 量化；未测 Q4/Q5/IQ 档，未测其他架构（LFM2.5-350M、MiniCPM5-2B、Gemma-3-270m 等）。
- 0.6B 的量化文件是 **Instruct** 版本，不是 JEV-CPU / SemIf 用的 **Base**；Base 未测（未新增下载）。
- 只用了**一种 ending**（`Answer:` cue）与「空格前缀」标签形式；`probe-ending` 显示另外两种 cue 也能读出标签，
  但未做准确率对比。
- 未做**温度校准 / 少样本规模化 / 指令微调格式**的实验（只在 noul 上试了 5 个变体）；
  未测多问题并行批处理（当前每题一次 HTTP 请求）；未测更长 state 的上下文退化。
- 0.6B 与 0.8B 的**延迟对比不是严格对拍**（测量时间、进程驻留状态不同，见 §5）。
- 未评估把该读出用在**非分类任务**（如自由文本抽取）上——本探针只覆盖 `noul`/`choice`/`score`。

---

## 9. 证据文件地图

```
experiments/gguf-provider/
  serve.mjs                     # /v1/systemone 适配层
  cli.mjs                       # 单次请求 / dry-run 捕获回放
  lib/{readout,render,labels,provider}.mjs
  eval/{run.mjs,items.mjs}      # 20 条自明真值评测（--rotate / --rotate-ks / --rotate-only）
  lab/{tokenizer-probe,probe-ending,probe-noul-bias,check-normalize,latency}.mjs
  fixtures/                     # 5 个真实 skill --dry-run 捕获 + judge-state/questions.json
  results/
    eval-0.6b.{json,log}  eval-0.8b.{json,log}          # 20 条正评 + 标准轮转（k=0,3,7）
    rotate-extra-0.6b.{json,log}  rotate-extra-0.8b.{json,log}   # 单题轮转 k=0..3
    baseline-first-option.json                          # 「恒选第一个选项」基线逐题判定
    check-normalize-0.6b.txt  check-normalize-0.6b-recheck.txt  check-normalize-0.8b.txt  # 27/27
    skill-judge-0.6b.json  skill-judge-0.8b.json        # 真实 skill CLI 端到端
    latency-0.6b.txt  latency-0.8b.txt                  # 真实 step 冷/热延迟
    tokenizer-0.6b.json  probe-ending-0.6b.txt  probe-noul-bias-0.6b.txt
```

（本文件与 `docs/local-kev-bringup.md`（Kev 路线）以及 `docs/local-models-research.md`（选型调研）构成一组：
调研 → 有训练头的可行路径 → 无训练路径的否证。）

# 本地可安装的 Jev 替代方案调研（面向 `skills/jev-browser`）

- 调研日期：**2026-09-23**（所有 URL 均于该日抓取；每条断言标注来源与来源自身的日期）
- 目的：找出今天真实存在、可本机安装、且能当作 TypeSafe Jev 替代品的决策模型（decision model），重点是 **sub-1B** 可随 skill 一起分发的选项，并给出一条「一键安装」路径。
- 读法约定：凡非直接引用来源的推断，均标 `[INFERENCE]`；未经验证的数字不写。

---

## 0. 结论速览

| 结论 | 内容 |
|---|---|
| 唯一真正的 drop-in | **Kev**（`jaredpalmer/kev`，Apache-2.0）明确「serves TypeSafe's public `/v1/systemone` contract」，且官方 `typesafe-sdk` 改 `base_url` 即可用；`Laya` 的 `laya-serve` 声明同样支持 `POST /v1/systemone`（两条独立路线）。 |
| 唯一可随 skill 分发的 sub-1B 决策模型 | **Kev-0.8B**（LoRA r=16 + pointer head on `Qwen/Qwen3.5-0.8B-Base`，仓库主体 ~113 MB，base 1.76 GB）；上一代 **Kev-0.6B**（Qwen3-0.6B-Base，仓库 ~96 MB，base 1.19 GB）在 Mac 上是更快的一档；原型 **Kev-0.5B**（Qwen2.5-0.5B）作者已标为「prototype，生产请用 0.8B+」。 |
| 无下载量的兜底 | 未训练的 `Qwen3-0.6B` + **首 token logprob 读法**（JEV-CPU / SemIf 的 trick）可在 ~2.4 GB RAM、纯 CPU、约 1 s/决策跑起来，但需要自己包一层 `/v1/systemone`，且质量是「下限」。 |
| Apple Silicon 现实 | Qwen3.5 系（0.8B/4B/9B）的 **Gated DeltaNet 层没有 PyTorch MPS kernel**，Kev 在 Mac 上自动改走 **MLX**；Qwen3 世代（0.6B/4B/8B）仍走普通 PyTorch MPS，是 Mac 上「更快的老选择」。 |
| 质量天花板 | 本机可拿到的最好开源近似是 **Kev-9B**（新来源 locked test 0.852，Jev dev 0.857）与 **Open-Jev-27B-v1.1**（JevBench public 197/231 = 85.28%），但都远超 sub-1B；**Kev-0.8B 域外只有 0.652**。 |

---

## 1. 我们要匹配的契约（从本仓库代码读出）

来源：本仓库 `skills/jev-browser/lib/typesafe.mjs`、`lib/config.mjs`、`lib/questions.mjs`（本次会话直接阅读，2026-09-23）。

```
POST {baseUrl}/v1/systemone
Authorization: Bearer <key>
Body: { model, state, questions }
Resp: { model, answers, usage }
```

- `questions[id]` 只允许三种：`noul`（二值概率）、`choice`（`criteria` 为 2..255 个选项的对象）、`score`（2..10 个有序层级数组，答案概率键为 `"0"`,`"1"`,…）。
- 客户端解析（`normalizeAnswers`）要求 `answers[id].type === questions[id].type`，并读取 `noul` / `probabilities` / `choice` / `score` / `confidence`；`usage.input_tokens` 决定成本估算（`pricePerMtok` 默认 0.042 USD/Mtok，仅按输入计费）。
- 构造 `TypeSafeClient` 时 **apiKey 不可为空**（否则抛 `MISSING_API_KEY`），所以挂本地服务时需要 `TYPESAFE_API_KEY=local` 之类的占位值，并把 `pricePerMtok` 设为 0（本地无计费）。
- 每次请求按 `sha256(model+state+questions)` 缓存；对 408/409/425/429/5xx/529 会重试（默认 2 次）。
- 负载特征：每个控制步把**一组互相独立的问题**（`goal_done` noul、`blocker` choice、`action` choice、`click_target`/`type_target`/`select_target` choice、`progress` score…）**放在同一次请求里并行评估**，state 是一份观察到的页面（url/title/headings/visible_text/elements）。
- 因此本地服务必须满足：**一次请求多个问题**、**noul+choice+score 混合**、**返回逐问题分布**、**低延迟**（每步一次调用，`maxSteps` 默认 25）。

> 合规检查（谁满足这条）：Kev ✅（明确声明）、Open-Jev ✅（`Official /v1/systemone request/answer shape; partial API compatibility`）、openjev-sglang ✅（实现了完整 `/v1/systemone`）、Laya ✅（`laya-serve` 声明 `POST /v1/systemone`）、DiffusionGemmaJev ⚠️（vLLM PR 内的**示例 interposer server**，非标准端点）、SemIf ❌（CLI/库，无该端点）、JEV-CPU ❌（自有 `POST /api/decide` 形状）、Jevlike ❌、CUA-S1 ❌（专用表单模型）。

---

## 2. Kev 家族（github.com/jaredpalmer/kev）

来源：GitHub 仓库页 README（Apache-2.0，5,080 stars，2026-09-23 抓取）；HF collection `huggingface.co/collections/jaredpalmer/kev`（2026-09-23，页面标注 "updated about 10 hours ago"，共 **26 个**条目）；各 checkpoint 的 HF model card / HF API（`/api/models/<id>`）。

### 2.1 家族总表（作者同口径，dev / locked test）

| 模型 | HF repo | base | 训练来源 acc (dev / test) | 新来源 acc (dev / test) | 新来源 Brier (dev / test) | 状态 |
|---|---|---|---|---|---|---|
| Kev-0.5B | `jaredpalmer/kev-0.5b` | Qwen2.5-0.5B | 0.712 / – | 0.575 / – | – | v0.1 prototype，作者明示「Use Kev-0.8B+ for production work」 |
| Kev-0.6B (Qwen3) | `jaredpalmer/kev-0.6b` | Qwen3-0.6B-Base | 0.801 / 0.808 | 0.620 / 0.642 | 0.536 / 0.483 | 上一代，不再开发，但 Mac 上更快 |
| **Kev-0.8B** | `jaredpalmer/kev-0.8b` | Qwen3.5-0.8B-Base | **0.825 / 0.834** | **0.652 / 0.684** | **0.499 / 0.460** | 当前最小成员 |
| Kev-4B | `jaredpalmer/kev-4b` | Qwen3.5-4B-Base | 0.872 / 0.871 | 0.797 / 0.837 | 0.299 / 0.255 | 推荐起点 |
| Kev-9B | `jaredpalmer/kev-9b` | Qwen3.5-9B-Base | 0.872 / 0.874 | 0.822 / **0.852** | 0.286 / **0.237** | 精度/校准最好 |
| Kev-4B (Qwen3) | `jaredpalmer/kev-4b@qwen3` | Qwen3-4B-Base | 0.854 / 0.856 | 0.790 / 0.806 | 0.328 / 0.294 | 上一代 |
| Kev-8B (Qwen3) | `jaredpalmer/kev-8b` | Qwen3-8B-Base | 0.863 / 0.870 | 0.796 / 0.780 | 0.337 / 0.327 | 上一代 |
| **Jev（托管参照）** | 闭源 | – | 0.845 / – | **0.857 / –** | **0.211 / –** | – |

- 0.8B/4B/9B 于 **2026-09-21** 用一次「delta 微调」（补 day-count 政策样本 + 证据被删除的样本）更新；旧权重在 revision `v7-base`。test 上：9B 0.837→0.852、4B 0.832→0.837、0.8B 0.668→0.684（95% CI 见 README）。[Kev README, 2026-09-21]
- 作者明确：**不知道 Jev 训练在哪些数据上，所以这不是受控对比**。[Kev README]
- sub-1B 只有三个：0.5B / 0.6B / 0.8B。

### 2.2 逐 checkpoint 细节

| | Kev-0.5B | Kev-0.6B | Kev-0.8B |
|---|---|---|---|
| base | `Qwen/Qwen2.5-0.5B` | `Qwen/Qwen3-0.6B-Base` | `Qwen/Qwen3.5-0.8B-Base`（rev `dc7cdfe2`） |
| 结构 | LoRA + head | LoRA + head（2 个公开评分口径略有差异：0.799/0.065 vs 0.805/0.819） | LoRA **r=16，11.3M 可训练参数** + pointer head |
| license | apache-2.0 | apache-2.0 | apache-2.0（base 亦 apache-2.0） |
| 关键指标 | acc 0.799、ECE 0.065（T=1.47 后 0.031） | in-dist 0.801、ECE(raw) 0.086；OOD 0.620、Brier 0.536 | in-dist 0.825、ECE(raw) 0.110；OOD 0.652、Brier 0.499；confident errors 9.9% |
| 特殊 | 只有 6 个训练来源 | 10 个训练来源 | 10 个训练来源 + 程序化 policy；**as served（内置 T=2.41）：Brier 0.430 / ECE 0.054 / confident errors 0.3%** |
| HF 仓库体积（usedStorage） | 48,496,279 B | 96,466,828 B | 112,974,986 B |

Kev-0.8B 逐文件（HF API `?blobs=true`，2026-09-23）：`adapter_model.safetensors` **43,338,624 B**、`head.pt` **2,103,103 B**、`tokenizer.json` 19,989,325 B、`README.md` 7,257 B、`result.json` 73,917 B。

base 模型下载体积（HF API `usedStorage`，2026-09-23）：Qwen3.5-0.8B-Base **1.76 GB**（873,438,784 参数 BF16）、Qwen3.5-4B-Base **9.33 GB**（4.66B 参数）、Qwen3.5-9B-Base **19.32 GB**（9.65B 参数）、Qwen3-0.6B-Base **1.19 GB**（596M 参数）。

### 2.3 精度缺口与「confident error」数据（作者自测，同一批冻结 item）

| 指标 | Kev-0.6B | Kev-0.8B | Kev-4B | Kev-9B | Jev |
|---|---|---|---|---|---|
| 域外 confident errors（p≥0.9 且错） | 10.8% | 9.9% | 6.9% | 8.7% | **3.7%** |
| 5% 误差预算下可自动化比例（coverage） | – | 0.23 | 0.54 | 0.47 | **0.70** |
| held-out policy 结构（两个兄弟都对） | 0.08 | 0.42 | 0.78 | 0.83 | 0.86 |
| 选项顺序翻转率 | 0.07 | 0.08 | 0.08 | 0.03 | 0.00 |

逐来源 OOD（Kev-0.8B / Jev）：QNLI 0.85/0.93、SciQ 0.91/0.99、TweetEval-offensive 0.68/0.81、PAWS 0.55/0.79、**MMLU 0.42/0.90**、Emotion 0.54/0.59、authorization 0.97/1.00、**deadline（3 级日期算术）0.38/0.93**、(A or B) and C 0.66/0.91、(A and B) or not C 0.56/0.97、if A then not B else C 0.59/0.78。[Kev-0.8B card]
第三方套件（作者转测，live Jev 对照组）：SemIf 144 条 authored（Kev-9B **0.917** vs Jev 0.965）、scienthoon 900 张工单（Kev-9B 0.952 routing / 0.911 tone，Jev 0.897 / 0.914，**Kev 反而更高**）、WANLI 256（Kev-9B 0.703 vs Jev 0.758）、typesafe-v1 102 行（Kev-9B 0.809/0.226、Kev-4B 0.856/0.231 vs Jev 0.891/0.125）。[Kev README]

### 2.4 校准 / 温度处理

- 每个 checkpoint 内置 **一个在 in-distribution dev 上拟合的温度（约 2.1–2.4）**，由 pointer head 在加载时应用；**温度不改变任何答案**，只改概率质量。Kev-9B 新来源上 calibration error 0.106→0.042、confident errors 8.7%→4.0%（≈Jev 的 3.7%），accuracy 不变。[Kev README]
- `KEV_TEMPERATURE=1.0` 关闭；`scripts/calibrate_checkpoint.py` 给出 out-of-fold（group-disjoint 5-fold）校准误差与 bootstrap 区间（Kev-4B dev：raw 0.075 / out-of-fold 0.020，95% 区间 0.014–0.041，差值区间不含 0）。[Kev README]
- README 表格里的 accuracy 与 Brier 是 **raw logits**口径；model card 表里的 "as served" 一行才是内置温度口径。混用会读出不一致的数。
- ⚠️ **merged weights 的坑**（Bespoke Nimble 明示，Kev 未声明）：`The logits from merged weights can be slightly different. We did not check the temperature again on the merged weights.`[Nimble README, 2026-09-23] — 对任何合并 LoRA 的本地部署都是同一类风险。
- 关于「校准只靠一个温度」的边界，Kev 作者自己写：固定温度无法重排次序，所以 5% 误差预算下可自动化比例（0.45–0.57）仍低于 Jev 的 0.70。[Kev README, Limitations]

### 2.5 服务与 API

```bash
# Kev 官方 Quick Start（README, 2026-09-23）
git clone https://github.com/jaredpalmer/kev.git && cd kev
uv sync --extra serve
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009
```

- 路由：`POST /v1/systemone`、`GET /v1/models`、`POST /v1/systemone/permute`（同一 Choice 的多种选项顺序）、`POST /v1/systemone/separate`（每个问题单独前向）；每个响应带 `x-typesafe-request-id`。
- 默认绑定 `127.0.0.1` 且**默认不鉴权**；`KEV_API_KEY` 可要求 `Authorization: Bearer`（TypeSafe 客户端总会发这个头）。
- question 约束与我们的契约一致（noul 可选 true/false 描述；choice 1–255 选项；score 1–255 有序层级），confidence 公式作者标注为「TypeSafe 公式的近似，非公开」。单请求问题数不限，按 16,384 token 一个 batch 行分块（state 在每个问题里各计一次）。
- Python 侧可直接用官方 SDK：`TypeSafeClient(api_key="local", base_url="http://127.0.0.1:8009", model="kev-latest")`。[Kev README]

### 2.6 Apple Silicon / MLX 真相

Kev README「Serving Performance」一节 + Kev-0.8B card「Known limits」：

| 事实 | 内容 |
|---|---|
| CUDA/ROCm | 装 `flash-linear-attention` 后，五问请求在 H100/MI300X 上「tens of milliseconds」。 |
| Mac（Qwen3.5 系） | **「there are no PyTorch kernels for the DeltaNet layers, so the server runs the Qwen3.5 models through MLX instead（`uv sync --extra serve` 在 Mac 上会装 MLX）。Only the backbone changes ... the probabilities match the fp32 PyTorch path to bf16 rounding.」** |
| 精度对拍 | 1,024 条 decision-v7 dev（1,264 问）：Kev-4B 最大差 0.025 / 均值 0.0016，最高概率答案改了 1 个；Kev-0.8B 最大差 0.054 / 均值 0.0023，改了 4 个（0.3%）。 |
| 延迟（M5 32 GB，5 问×3 选项，~270 token state，直接调模型） | Kev-0.8B：**新 state 149 ms / 命中 prefix cache 28 ms**；Kev-4B：721 ms / 136 ms；对照 PyTorch bf16 on MPS：0.8B 1062/276 ms、4B 3302/847 ms。 |
| 另一处口径 | Kev-0.8B card 写 **「a five-question request takes ~0.33 s in bf16 on an M5（Kev-0.6B: 0.12 s）」**，并把根因写成「DeltaNet kernels have no MPS implementation」。⚠️ 与 README 的 149 ms 口径不一致（0.33 s vs 0.149 s），来源未解释，**上线前必须自测**。 |
| 回退开关 | `KEV_BACKEND=torch` 或 `KEV_DTYPE=fp32` 会强制走 PyTorch；`/v1/models` 会报告当前 backend 与 dtype。 |
| 老世代 | `kev-4b@qwen3`、`kev-8b`、`kev-0.6b` 仍是 plain PyTorch MPS，「remain a fine choice on a Mac」。 |
| 复现脚本 | `scripts/mlx_parity.py --run jaredpalmer/kev-4b`。 |
| 其他 Mac 侧开关 | `KEV_MERGE=0`、`KEV_ATTN=eager`、`KEV_SHAPE_BUCKET=1`、`KEV_PREFIX_CACHE=0`。 |

### 2.7 Kev 的已知局限（对我们最相关的四条）

1. **训练上下文 ≤384 state token**（state+question 共 1,024），服务允许 8,192 state+question —— 长页面（我们的 `visible_text` + elements）会落到训练分布外；作者把「更长训练上下文」列为 planned fix（issue #48）。
2. **服务器一次只处理一个请求**（有 state 前缀缓存，不跨调用方 batching）。
3. 选项顺序会改变答案（isolation 只保证问题之间互不可见）。
4. 知识类问题（MMLU 0.74 vs Jev 0.90；MMLU-Pro 0.52 vs 0.84）基本由 base 决定，训练补不上。
5. 需要 `transformers >= 5.17`、`peft >= 0.21`（0.8B card 明示）。

---

## 3. 其他 Jev-like / decision-model 项目

| 项目 | 是什么 | 规模 | license | 运行时要求 | 说 `/v1/systemone` 吗 |
|---|---|---|---|---|---|
| **ekzhang/openjev-sglang**（286 stars） | 用 SGLang + Qwen3.6-35B-A3B 实现的 Jev HTTP API（prefill-only） | 35B-A3B（启 `nvidia/Qwen3.6-35B-A3B-NVFP4`） | 仓库未见 LICENSE 字段（GitHub 页面无 license 标注） | 1×B200 容器（Modal `unauthenticated=True`）或自备 SGLang 后端；本地 `uv sync` 只装 API | ✅ 完整实现（含 `/v1/models`、`/v1/limits`、`/health`） |
| **Zefan-Cai/Open-Jev**（246 stars；站点 zefan-cai.github.io/open-jev） | 独立复现：LoRA + trained scalar decision head + saved calibration temperature | 2B / 9B（旧）与 **27B-v1.1**（LoRA rank 8） | 模型包 apache-2.0（base 需自行 pin upstream Qwen，权重不含） | Python 3.10+，「model inference requires the training dependencies and a suitable GPU」；Docker 有 CPU 变体（much slower） | ✅「Official `/v1/systemone` request/answer shape; partial API compatibility, not the full hosted service」 |
| **TheoLeeCJ/SemIf**（3,979 stars；fka OpenJev） | 「读选项 logits」的 4B 基线 + 全套评测/校准脚本 | Qwen3.5-4B（也支持 MiniCPM5-2B、Qwen3.8-27B EXL3） | MIT（代码；模型权重不含） | 单卡 CUDA 3090 起步；`--backend mlx`（macOS arm64）、`--device mps`、`--backend llamacpp --gguf …`（纯 CPU） | ❌ 无 HTTP 服务；CLI `semif-score` + 库 |
| **JEV-CPU**（`Meanblock/JEV-CPU`；leesk212/JEV-CPU） | SemIf 的 CPU 移植 + Web UI，Qwen3-0.6B float32 从 logits 读决策 | 0.6B（~2.4 GB RAM） | MIT | CPU only，Python 3.10+，~3 GB RAM，无 GPU | ❌ 自有 `GET /api/health`、`POST /api/decide`（stdlib server，端口 8080） |
| **NandhaKishorM/laya**（18,652 stars） | 非自回归 System-1 决策引擎（ModernBERT 系 encoder + option attention + Router） | `laya` 421M ctx512 / `laya-multilingual` 322M ctx1024 / `laya-typed-decisions` 421M ctx1024 | Apache-2.0 | Python 3.10+、`transformers` 5.x、`torch` 2.14；CPU 可跑（Docker quickstart），T4 上 33 ms/问、批量 7.2 ms/问 | ✅「`pip install "laya[serve]"`, then `laya-serve`, speaks `POST /v1/systemone`」 |
| **bespokelabsai/nimble**（1.7k stars） | 「open Jev」配方：contrastive 数据筛选 + LoRA on Qwen3.5-9B + 合并权重 | 9B | README 未见 license 声明（GitHub API 取 metadata 返回 403，未确认） | Mac 需 Apple Silicon + MLX（`ParallelScorer`）；Linux 需支持 BF16 的 NVIDIA GPU；**需同时留出 base 与 merged 权重的磁盘** | ❌ 提供 Python scorer 与 SGLang 托管部署指南，未声明 `/v1/systemone` |
| **vinnylarouge/jevlike**（1,250 stars） | 从零训练的小型 option-attention scorer（byte embedding，可选冻结 HF encoder） | 默认 40K byte embedding 级；可选 Qwen2.5-0.5B 冻结 encoder | MIT | CPU / Apple MPS / CUDA（`--device`） | ❌ 无 HTTP 服务，研究 starter |
| **cua-ai/cua-s1-forms**（trycua 家族） | 表单填充的 System-One 小模型（option-attention，.pt/.safetensors） | 第三方报道 **706K 参数 / 2.8 MB**（HF 页面仅给文件不带参数量） | MIT | HF 权重 + 推理脚本；社区已转 **CoreML/ANE**（`FluidInference/cua-s1-forms-coreml`，含 fp16/int8/int4 与 ANE profiling 报告） | ❌ 专用（form-filling），非通用决策 API |
| **DiffusionGemmaJev（vLLM PR #57250，已 merged 2026-09-22）** | 在 diffusion 模型上用固定 canvas + 单 token 选项做「结构化读出」，附**示例 `structured_server.py` 暴露 `/v1/systemone`** | `nvidia/diffusiongemma-26B-A4B-it-NVFP4` | 属 vLLM 仓库（Apache-2.0） | 需 vLLM ≥ 该 PR + 1×DGX Spark 级 GPU；作者明示「does not implement a standard endpoint in vLLM」 | ⚠️ 示例服务，非官方端点 |
| **Busy-Office/kev-agent-kit（内含 `integrations/kev-mcp`）** | 把本地 Kev 通过 MCP 暴露给 Claude Code / Codex / Google Antigravity，附 Docker + 全局安装器 | 继承 Kev（默认 **0.5B** checkpoint） | Apache-2.0 | Docker Compose + uv + Python 3.12+ + Node 20+；API 8008 / playground 8009 | ✅ 通过 Kev（自身不含模型） |
| **TypeSafe Jev 本体** | 托管服务，未开源权重 | 闭源 | 闭源 | 需要 API key | ✅（原生） |

补充事实：

- Latent.Space 的综述把「Jev clones in 2 days」列成 6 个：Laya、DiffusionGemmaJev、Bespoke Nimble、SemIf(fka OpenJev)、Jevlike、Kev-0.5B，并给出各自的一句话定性（Laya「421M params, ModernBERT-large encoder … confidence is entropy-based, not calibrated」；Bespoke Nimble「LoRA finetune of Qwen3.5-9B … base 66%→90% vs Jev 93%」）。[latent.space, 2026-09-19]
- OpenJev（SemIf）作者的定性：**「The first thing to establish is that OpenJev is not the official open-source version of Jev. TypeSafe has not released the model weights」**。[dev.classmethod.jp 转述, 2026-09 抓取] ＋ SemIf README 自述「reproduces that interface pattern; it does not reproduce Jev's undisclosed model or training」。
- OpenJev 的概率**未经校准**（README：`Probabilities are conditioned on the supplied options … and are not calibrated estimates of correctness`），其 `confidence = 1 - H/log(K)` 是熵式指标。SemIf 提供 per-workload temperature scaling，可作为对照实现（authored144 ECE 0.068→0.038 @T=1.23；WANLI 0.208→0.069 @T=2.50）。
- Open-Jev 的推理性能记录：客服场景本地 HTTP 中位 **85.03 ms** vs Jev HTTPS 295.26 ms；但 1,024 state token + 32 候选时 **1015.90 ms** vs Jev 301.37 ms；CUDA prefix caching 在 11 个工作负载中有 9 个超出概率容差，故默认关闭。[Open-Jev README, 2026-09-23]
- Open-Jev 的第三方横向数据（JevBench public 231 题）：2B 150/231（64.94%）、9B 179/231（77.49%）、27B-v1.1 197/231（85.28%，Hard 80/111 = 72.07%），Jev 高 3 题。[Open-Jev README]

---

## 4. 未训练 sub-1B + 「prompt + 首 token logprob」方案

这条路线不训 LoRA/head，只把决策问题渲染成「下一个 token 是 A/B/C…」的 prompt，然后从**最后一个位置的 logits** 里只取选项槽位做 softmax。参考实现见 JEV-CPU README「How a decision is read from logits」（CPU 版 SemIf，2026-09-19）：

1. 每个选项映射成一个大写字母，prompt 以 assistant 头结束（`add_generation_prompt=True`、`enable_thinking=False`）；
2. `_slot_ids()` 校验每个字母是**单 token** 且 round-trip（`decode(encode("A")) == "A"`），保证槽位干净、不被空白合并；
3. **一次前向**：`logits = model(**inputs, use_cache=False).logits[:, -1, :]`；
4. `softmax(logits[slot_ids])` → 每个选项一个概率，取 argmax 即答案。

同源方法在服务端的等价实现见 openjev-sglang：`max_new_tokens=1` + `token_ids_logprob` 拉取所有答案标签的 logprob，再做 stable softmax 归一化；标签用 `A`–`Z` 及验证过的 `AA`,`AB`,… 组合，启动时对照 tokenizer 全量校验（因为 Qwen 会把 `10`/`64` 切成多 token）。[openjev-sglang README, 2026-09-23]

### 4.1 可选模型与其证据

| 模型 | 参数量 | license | GGUF | 上手证据 |
|---|---|---|---|---|
| **Qwen3-0.6B**（含 `-Base`） | 751,632,384（BF16，HF `safetensors` 字段） | apache-2.0 | 生态齐备（HF GGUF 社区大量） | **SemIf 浏览器阶梯：authored 平衡准确率 0.440 / 扰动 0.528 / TypeSafe 子集 0.407**；JEV-CPU 用它在 CPU 上 ~1 s/决策跑通 8 个域 13 条示例（含一条 loan 决策自相矛盾的失败样本） |
| **Qwen3.5-0.8B / -Base** | 873,438,784（BF16） | apache-2.0 | `unsloth/Qwen3.5-0.8B-GGUF`（Q3–Q8、IQ、UD 全档） | 作为 Kev-0.8B 的 base，被同一 recipe 训到 0.825 in-dist |
| **SmolLM2-360M / -Instruct** | 360M 级 | apache-2.0 | 有 `SmolLM2-360M-Instruct-GGUF`（仅 q8_0）；原模型带 ONNX（含 `transformers.js` tag） | 无决策任务公开证据 → `[INFERENCE]` 只能当「量级参考」 |
| **SmolLM3-3B / -3B-Base** | 3B | apache-2.0 | 有 ONNX | ⚠️ **SmolLM3 没有 360M 版本**（HF 检索只有 3B）；需求清单里的「SmolLM3-360M」应是把 SmolLM2-360M 记错了 |
| **Gemma-3-270m** | 270M | `license:gemma`（自定义、**HF 上 `gated: manual`**） | `unsloth/gemma-3-270m-it-GGUF`（含 IQ/UD 多档） | 无决策任务公开证据；许可证需人工审批 → 不适合「随 skill 分发」 |
| **LFM2.5-350M** | 350M | `license: other`（LFM Open License） | **官方** `LiquidAI/LFM2.5-350M-GGUF`（BF16/F16/Q4_0/Q4_K_M/Q5_K_M/Q6_K/Q8_0 + QAD） | 有第三方 RLCD/约束解码衍生版（`notnotsamuel/LFM2.5-350M-RLCD`，tag 含 `apple-silicon`、`structured-generation`）；无中立决策基准 |
| **MiniCPM5-1B / 2B** | 1B / 2B | apache-2.0 | 官方 GGUF（2B：F16/Q4_K_M/Q8_0）；另有 **MLX** 版与社区 abliterated GGUF | **SemIf 阶梯：MiniCPM5-2B authored 0.686 / 扰动 0.693 / TypeSafe 子集 0.637**；JEV-CPU 作者把它列为「修掉 0.6B 二次决策矛盾」的下一档 |
| **Qwen3.5-2B** | 2B 级 | apache-2.0 | 社区 GGUF | Open-Jev-2B 的 pinned base（`--revision 15852e8c…`），JevBench 150/231 |

### 4.2 这条路的校准现实

- 未训练模型给出的选项概率**直接来自 softmax，未经校准**；需要用 labeled 切片拟合温度。可直接抄 SemIf 的做法（per-workload ECE/温度表）与 JEV-CPU 的 `option_logits + probabilities` 输出契约。
- JEV-CPU 自己记录了 0.6B 的**一致性问题**：loan/credit 示例里模型正确判定「high risk」却仍倾向「approve」，「an inconsistency that larger models resolve」。
- 结论：sub-1B 未训练模型的定位是**离线兜底 / 消融对照**，而不是生产替代。

---

## 5. macOS 本地运行时对照（Apple Silicon）

| 运行时 | 能跑什么 | 能否承载 Jev 形状 HTTP API | 缺什么 / 代价 |
|---|---|---|---|
| **uv + PyTorch（MPS）** | Kev 的 Qwen3 世代（0.5B/0.6B/4B/8B）、SemIf（`--device mps`） | ✅ 直接跑上游 Python 服务 | Qwen3.5 的 DeltaNet 层**无 MPS kernel**；需 `transformers>=5.17`；Kev 在 Mac 上会自动绕开这条路 |
| **MLX（`mlx-lm`）** | Kev Qwen3.5 系（0.8B/4B/9B）、Nimble-9B、SemIf `--backend mlx`、MiniCPM5-2B-MLX | ✅（Kev 自带 MLX backbone；`mlx_lm.server` 自身即 OpenAI 兼容服务） | `mlx_lm/server.py` 支持 chat completions 的 `logprobs`/`top_logprobs`（源码校验 `top_logprobs` 上限 **11**，`-1` 白名单）→ 若要「任意指定 token 的 logprob」仍需自写 |
| **llama.cpp / `llama-server`** | 任何有 GGUF 的模型（Qwen3.5-0.8B、LFM2.5-350M、MiniCPM5、Gemma-3-270m…） | ⚠️ 需自写 adapter | 支持 `n_probs`（>0 时响应带 `completion_probabilities`，含每 token 的 `top_logprobs`；`post_sampling_probs` 给采样链后概率；`temperature<0` 时 greedy 但概率仍按 softmax 计算）；缺点是**没有**「指定 token id 列表」的原生入参（vLLM 有 `logprob_token_ids`），只能取 top-N 再筛选项字母 |
| **Ollama** | 同上（模型以 GGUF 分发） | ⚠️ 需自写 adapter | `/api/generate` 与 `/api/chat` 都接受 `logprobs: bool` + `top_logprobs: int` 并返回 `Logprob`/`TokenLogprob`（官方 OpenAPI schema）；但社区报告 **OpenAI 兼容端 `/v1/chat/completions` 不返回 logprobs**（GitHub issue, 2026-01-07） |
| **LM Studio** | 同上，开发者模式起本地 REST server（官方文档） | ⚠️ 未确证 | 本次抓取的官方 OpenAI 端点文档页**未出现 logprob 字样**；2024-08 的 issue #60 记录「logprobs 未在响应中返回」。`[INFERENCE]` 现在可能已支持，必须实测 |
| **transformers.js** | 浏览器/Node 内跑 ONNX（SmolLM2 等带 ONNX 的模型） | ❌ 不适用（浏览器内算力与内存受限；且其文档化的 text-generation 输出是文本） | 需要的「读下一 token 的选项 logits」不是 pipeline 的公开输出；`[INFERENCE]` 要自己用底层 forward 取 `logits`。SemIf 的浏览器 demo 用的是**量化 GGUF**（Q8_0/Q4_K_M），说明浏览器路径实际走的是别的推理栈 |
| **自写 Python（PyTorch/MLX）** | 一切；这就是 JEV-CPU / SemIf / Kev 内部的做法 | ✅（最灵活） | 需要自己维护 HTTP 层；但换来对 `/v1/systemone` 的完全控制（多问题并行、置信度、per-question 隔离） |

补充：CoreML/ANE 路线已有人趟过（CUA-S1-Forms → `FluidInference/cua-s1-forms-coreml`，含 fp16/int8/int4 与 ANE profiling/verification 报告），说明「sub-MB 级 option-attention 模型上 Apple Neural Engine」在 2026-09 是可行的。[HF `FluidInference/cua-s1-forms-coreml`, lastModified 2026-09-22]

---

## 6. 推荐矩阵

### 6.1 默认内嵌（sub-1B）

| 方案 | 模型 | 何时选 | 成本 | 许可风险 |
|---|---|---|---|---|
| **首选：Kev-0.8B** | LoRA+head on Qwen3.5-0.8B-Base | Mac 上希望「一个命令 + 一个 drop-in 端点」且接受 MLX 路径 | 仓库 ~113 MB + base 1.76 GB；bf16 权重 ~1.8 GB RAM；MLX 实测 149 ms/新 state、28 ms/命中缓存（5 问） | 低（Kev 与 Qwen3.5 base 均 Apache-2.0） |
| **Mac 更快档：Kev-0.6B（Qwen3）** | LoRA+head on Qwen3-0.6B-Base | 想要纯 PyTorch MPS、无 MLX 依赖、可接受 OOD 0.620 | 仓库 ~96 MB + base 1.19 GB | 低 |
| **零下载兜底：Qwen3-0.6B + 首 token logprob** | 未训练 base | 连下载 LoRA 都不想、或要做消融对照 | ~1.19 GB 权重 / CPU float32 ~2.4 GB RAM，~1 s/决策 | 低（Apache-2.0），但要自己写 `/v1/systemone` 适配层 |
| ❌ 不建议：Kev-0.5B | Qwen2.5-0.5B | 只有研究者会想用 | 仓库 48 MB | 作者自己标注 prototype |

**默认建议：Kev-0.8B 作为「本地 Jev」默认档，Kev-0.6B 作为 `--backend=torch`/省内存档，未训练 Qwen3-0.6B 只作为 offline fallback 与对照。**

> **2026-09-24 更新（实测）：本节写于 4B 尚不可下载时，这条默认建议不再成立。** 0.8B 在 20 条自明真值上只有
> **14/20 = 0.70**，真实 fixture 页 `goal_done` = **0.6952**（假成功）⇒ 不能当默认档。实际落地是两层：默认
> **GGUF readout**（0.80、零 Python、`bin/jev-local.mjs`）+ **Kev 4B 精度档**（**19/20 = 0.95**、
> `bin/jev-kev.mjs`、阈值带 0.341–0.683）；0.8B 只保留为「更快但更弱」。证据：
> `experiments/kev-4b/README.md`、`experiments/gguf-provider/results/local-models-4b.md`。

### 6.2 可选大模型（4B / 9B）

| 模型 | 磁盘（repo + base） | 内存（bf16 权重） | OOD 质量 vs Jev | 备注 |
|---|---|---|---|---|
| Kev-4B | base 9.33 GB | ~9.3 GB | 0.797 dev / **0.837 test**（Jev 0.857 dev） | 作者推荐起点；32 GB Mac 可服务 |
| Kev-9B | base 19.32 GB + repo 391 MB | ~19.3 GB | 0.822 dev / **0.852 test**，Brier 0.237 | 作者：32 GB Mac 可服务；confident errors 4.0% ≈ Jev 3.7% |
| Open-Jev-27B-v1.1 | 需 pinned upstream + loader | 远超本机 | JevBench 197/231（85.28%） | 27B 对本机不现实，仅作质量上界参照 |

### 6.3 质量对照：本地 vs 托管 Jev

| | Kev-0.8B | Kev-4B | Kev-9B | Jev（托管） |
|---|---|---|---|---|
| 训练来源 acc | 0.825 / 0.834 | 0.872 / 0.871 | 0.872 / 0.874 | 0.845 / – |
| 新来源 acc | 0.652 / 0.684 | 0.797 / 0.837 | 0.822 / **0.852** | **0.857 / –** |
| 新来源 Brier | 0.499 / 0.460 | 0.299 / 0.255 | 0.286 / **0.237** | **0.211 / –** |
| 5% 预算可用比例 | 0.23 | 0.54 | 0.47 | **0.70** |

（dev / test；来源 Kev README + 0.8B/9B card，2026-09-21 口径。）

### 6.4 一键安装路径（推荐）

```bash
# 1) 装模型服务（uv 由仓库自带指引，Python 3.12/3.13；Mac 上会自动带上 MLX）
git clone https://github.com/jaredpalmer/kev.git && cd kev
uv sync --extra serve
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8008

# 2) 让 jev-browser 指向本地（不动任何业务代码）
export TYPESAFE_BASE_URL=http://127.0.0.1:8008
export TYPESAFE_API_KEY=local          # 客户端要求非空 key；本地服务默认不校验
export TYPESAFE_DEFAULT_MODEL=kev-latest
# 并建议把成本估算归零：config set pricePerMtok 0

# 3) 自检
curl -s localhost:8008/v1/models | head
npx jev-browser judge --state "$(cat some-state.json)" --questions "$(cat q.json)"
```

备选的「无脑」路径（由第三方包装）：

- `docker compose up -d --build` + `uv run --frozen --directory integrations/kev-mcp python global_install.py install`（Busy-Office/kev-agent-kit，Apache-2.0），把本地 Kev 作为 MCP 工具接进 Claude Code / Codex / Antigravity，API 在 8008、playground 在 8009；注意它**默认拉 0.5B checkpoint**。
- 想按自己的问题集微调：Kev 提供 `--init_from`（从已发布 checkpoint 起训，而不是从 base）与可选的 agent skill `npx skills add jaredpalmer/kev@kev-finetune`。作者数据点：从 base 起训在 836 条支持工具决策上只拿 0.33（发布模型 0.84），而 `--init_from` 保住 0.83 并在新域到 0.88。

### 6.5 接入本 skill 时的具体风险与对策

| 风险 | 依据 | 对策 |
|---|---|---|
| 每步 5–8 问、最多 25 步，sub-1B 的 0.652 OOD accuracy 会**累积**成任务级失败 | Kev-0.8B OOD 0.652；本仓库 `maxSteps` 默认 25 | 本地模式下降 `maxSteps`、对 `choice` 用 `confidence` 阈值、把「不确定」交给已有 `blocker`/`wait` 路径；并在真实页面上做 A/B 打分（同一 state 同时问托管 Jev 与本地模型） |
| state 很长（`visible_text` + elements）超出训练上下文 | Kev 训练 ≤384 state token、服务 8,192；issue #48 | 截断/摘要 state，或只把本地模型用在短 state 的判定（如 `goal_done`/`blocker`） |
| 概率口径混用导致阈值失效 | README 表 = raw logits，card "as served" = 内置 T；Bespoke 明确 merged weights 未复测温度 | 固定用「服务默认温度」口径，并在本仓库侧记录 `provider` 与温度设置 |
| 服务器串行、无并发 | Kev README：「handles one request at a time」 | 单步串行调用本身与我们的用法一致；不要并行发多请求 |
| Mac 延迟口径不一致 | card 0.33 s vs README 149 ms（同为 M5） | 上线前在目标机器跑 `scripts/mlx_parity.py` 与真实 5 问请求自测 |
| 许可 | Kev/Qwen3.5 为 Apache-2.0；Gemma-3-270m 是自定义 gated 许可；LFM2.5 是 `license: other`；Nimble 未见 license 声明 | 随 skill 分发的默认档只用 Apache-2.0 资产；其他档必须显式提示用户确认许可 |

---

## 7. 未决问题 / 需要实测的清单

1. **Kev-0.8B 在 M5 上的真实延迟**（card 0.33 s vs README 149 ms / 28 ms 缓存）——来源互相矛盾，必须自测，包括 MLX 与 `KEV_BACKEND=torch` 两条路径。
2. **本 skill 的真实问题分布上的准确率**：Kev 的所有公开套件都不是「网页元素选择」任务；需要把 `judge` 的 state/questions 采样一批，同时打托管 Jev 与本地 Kev-0.8B/4B，比较 top 答案一致率与 Brier。
3. **长 state 退化曲线**：把 `visible_text` 从 300 加到 4,000 token，测 Kev-0.8B/4B 的答案漂移（训练上下文 384/1,024 是硬边界）。
4. **跨请求的 state 复用收益**：Kev 有 prefix cache（`KEV_PREFIX_CACHE`），但我们的 state 每步都会变（`last_action`/`previous_page`），缓存命中率待测。
5. **Laya 作为第二 drop-in 的可行性**：`laya-serve` 声称 `POST /v1/systemone`，但未见其 response schema 与 TypeSafe 字段逐项对齐，需实测 `normalizeAnswers` 能否吃下（尤其 `choice` 的 `probabilities` 键名与 `confidence`）。
6. **LM Studio / transformers.js 的 logprob 能力**：官方文档未确证，若要用必须实测。
7. **Bespoke Nimble 的 license**（GitHub API 取 metadata 403，README 未声明）——在法务确认前不能进推荐默认档。
8. **是否有真正「训练过、sub-1B、非 Qwen」的决策模型**：本次调研中未发现（除 CUA-S1 这类领域专用与 421M 的 Laya）；`[INFERENCE]` 当前 sub-1B 通用决策的最优解仍是 Kev 家族。

---

## 8. 参考来源（URL + 日期）

| 来源 | 日期 | 用途 |
|---|---|---|
| https://github.com/jaredpalmer/kev | 2026-09-23 抓取（仓库 5,080★，Apache-2.0） | Kev 架构、API、性能、局限、微调、第三方套件 |
| https://huggingface.co/collections/jaredpalmer/kev | 2026-09-23（页面更新约 10 小时前） | 家族清单（26 项）、0.5B 说明 |
| https://huggingface.co/jaredpalmer/kev-0.8b ／ `/api/models/jaredpalmer/kev-0.8b?blobs=true` | 权重 2026-09-21；API 2026-09-23 | 0.8B 全部指标、逐文件体积、Mac 警告、依赖版本 |
| https://huggingface.co/api/models/jaredpalmer/kev-0.5b ／ `kev-0.6b` ／ `kev-4b` ／ `kev-9b` | 2026-09-23 | 各 checkpoint 指标、license、base、体积 |
| https://huggingface.co/api/models/Qwen/Qwen3.5-0.8B-Base ／ `Qwen3.5-4B-Base` ／ `Qwen3.5-9B-Base` ／ `Qwen3-0.6B-Base` ／ `Qwen3-0.6B` | 2026-09-23（base 权重 2026-04-23 更新） | 参数量、`usedStorage`、license、GGUF/ONNX 情况 |
| https://github.com/ekzhang/openjev-sglang | 2026-09-23（286★） | SGLang 方案、标签单 token 校验、limits、confidence 公式、无校准声明 |
| https://github.com/Zefan-Cai/Open-Jev ／ https://raw.githubusercontent.com/Zefan-Cai/Open-Jev/main/README.md | 2026-09-23（246★） | 2B/9B/27B、JevBench、延迟、Docker、`partial API compatibility` |
| https://huggingface.co/api/models/ZefanCai/Open-Jev-2B | 2026-09-23 | 包结构（adapter/head/temperature.json）、license |
| https://github.com/TheoLeeCJ/SemIf | 2026-09-23（3,979★，MIT） | 质量/速度/校准表、MLX 与 llama.cpp 后端、`not calibrated` 边界 |
| https://huggingface.co/Meanblock/JEV-CPU ／ https://huggingface.co/Meanblock/JEV-CPU/raw/main/README.md | 2026-09-19 | 首 token logprob 读法、CPU 延迟/内存表、`/api/decide`、token 上限 |
| https://github.com/NandhaKishorM/laya | 2026-09-23（18,652★，Apache-2.0） | 三个 checkpoint、`laya-serve` 与 `/v1/systemone`、33 ms/问 |
| https://github.com/bespokelabsai/nimble ／ HF `bespokelabs/Bespoke-Nimble-9B` | 2026-09-23（1.7k★） | 9B 对手、temperature 复测提醒、Mac MLX 路径 |
| https://github.com/vinnylarouge/jevlike | 2026-09-23（1,250★，MIT） | 从零训练路线与其精度下限 |
| https://huggingface.co/api/models?search=cua-s1 ／ `cua-ai/cua-s1-forms` ／ `FluidInference/cua-s1-forms-coreml` | 2026-09-19 / 2026-09-22 | CUA-S1 权重与 CoreML/ANE 化 |
| https://github.com/vllm-project/vllm/pull/57250 | merged 2026-09-22 | DiffusionGemmaJev、示例 `/v1/systemone`、DGX Spark 吞吐 |
| https://github.com/Busy-Office/kev-agent-kit ／ https://glama.ai（kev-mcp 条目） | 2026-09-23 | Docker+MCP 的一键集成路径 |
| https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md | 2026-09-23 | `n_probs` / `completion_probabilities` / `post_sampling_probs` |
| https://docs.ollama.com/api/generate ／ https://docs.ollama.com/api/chat | 2026-09-23 | Ollama 的 `logprobs` / `top_logprobs` |
| https://raw.githubusercontent.com/ml-explore/mlx-lm/main/mlx_lm/server.py | 2026-09-23 | MLX server 的 `logprobs`/`top_logprobs`（上限 11） |
| https://www.latent.space/p/ainews-here-are-6-clones-of-jev-in | 2026-09-19 | 「6 个 clone」的第三方清单与定性 |
| 本仓库 `skills/jev-browser/lib/{typesafe,config,questions}.mjs` | 2026-09-23（本会话阅读） | 必须匹配的契约与负载特征 |

---

## 9. Laya / Open-Jev 深挖（第二 drop-in 候选）

本节只回答两件事：(a) 它们能否作为与 Kev 并列的第二个本地后端；(b) 我们的 `normalizeAnswers`（`skills/jev-browser/lib/typesafe.mjs`）能否**不改代码**吃下它们的响应。

### 9.1 Laya（`github.com/NandhaKishorM/laya`，Apache-2.0）

#### 9.1.1 它到底是什么

**是训练出来的非自回归决策模型，不是套在生成式模型外面的 wrapper。** 证据：

- 自述 `Multilingual, non-autoregressive System 1 decision engine … trained with reinforcement learning against strictly proper scoring rules (RLCD), with a router that picks the right checkpoint per request`；单次前向 33 ms 量级，**不生成任何 token**。[Laya README, 2026-09-23 抓取]
- HF 卡片标签 `laya / system-one / calibrated-decisions / rlcd / classification / routing / scoring / guardrails / moderation / reinforcement-learning / commercial-use`，`library_name: transformers`、`auto_model: AutoModel`（即用 `AutoModel` 前向取选项分数，不是 `generate()`）。[HF `convaiinnovations/laya` API, lastModified 2026-09-23]
- 结构 = 预训练 encoder（ModernBERT-large / mmBERT-base）+ 在 encoder 之上加的自定义 option-scoring 层；权重里带 `rl_agent_config.json`（温度等配置随 checkpoint 走）。[HF 仓库文件表 + `laya/agent.py` 源码, 2026-09-23]
- Latent.Space 的第三方描述与之一致：`421M params, ModernBERT-large encoder with two added transformer layers that score user-supplied options, PPO over sequence embeddings`，并指出 `confidence is entropy-based, not calibrated`。[latent.space, 2026-09-19]（注意：Laya 自己后来的文档称温度是拟合出来的，见 9.1.3 的校准表。）

#### 9.1.2 全部公开 checkpoint（三者都 <1B）

| checkpoint | HF repo | 参数量（`safetensors` 字段） | 仓库 usedStorage | encoder / ctx | license | 是否 sub-1B |
|---|---|---|---|---|---|---|
| `laya`（英文档，含 `typed-decisions/`、`multilingual/` 子目录） | `convaiinnovations/laya` | **421,293,830**（F16 421,293,827 + F32 3） | 2,366,100,536 B（≈2.37 GB，含三个子目录） | ModernBERT-large，ctx 512 | apache-2.0 | ✅ |
| `laya-multilingual` | `convaiinnovations/laya-multilingual` | **321,908,998**（F16 321,908,995 + F32 3） | 678,198,702 B（≈678 MB） | mmBERT-base，ctx 1024 | apache-2.0 | ✅ |
| `laya-typed-decisions` | `convaiinnovations/laya-typed-decisions` | 未从 API 取到（README 表列 421M） | 未取 | ModernBERT-large，ctx 1024 | apache-2.0 | ✅（README 标 421M） |

三者的 ctx/用途出自 README 表：`laya` 421M/512「English」、`laya-multilingual` 322M/1024「100+ languages, 2x faster」、`laya-typed-decisions` 421M/1024「the typed-decisions workflows」。[Laya README, 2026-09-23]
Router 行为：默认只常驻 `english` + `multilingual` 两个（`max_loaded=2`），`max_loaded=1` 会在每次语言切换时重建（作者实测 CPU 中位 7.4 s、T4 10.3 s 重载）；`typed-decisions` **不会**被自动路由选中，除非显式 `--auto-task`/`model=`。[Laya README]

#### 9.1.3 质量数字 vs Jev（含作者自己声明的比较边界）

BENCHMARKS.md 开头的免责声明必须一起引用：**`Jev figures are third-party published, never measured here — no TypeSafe API access — so sample sizes and prompts differ; treat them as indicative.`**[Laya `BENCHMARKS.md`, 2026-09-23]

Headline：

| | Laya | Jev（published） |
|---|---|---|
| typed-decisions（2,000 decisions） | **0.766** | 0.727 |
| AG News（4 labels） | **0.953** | 0.910 |
| DAIR Emotion（6 labels） | **0.600** | 0.480 |
| ECE after temperature fitting | **0.081** | 0.246 |
| p50 latency, 1 question (T4) | **32.8 ms** | 236–276 ms |

但同一份文档也给出反面证据，必须一并看：

- **0.766 只属于 `laya-typed-decisions`，且是该 benchmark 自己的训练 split**；基础 checkpoint 在该 benchmark 上**低于多数类基线**（`laya` 0.361、`laya-multilingual` 0.342、majority 0.461、Jev 0.727、teacher ceiling 0.735）。作者原话：`All of the capability on this benchmark comes from fine-tuning.` + `Near chance on typed-decisions zero-shot`。[BENCHMARKS.md]
- **banking77 是明显败仗**：0.425 / 0.425 / **0.492** vs Jev 0.870；作者归因为架构（choice 的选项共享固定 `head_max_len` 预算，77 个标签每个只剩约 4 token），并建议 `Keep choice questions under ~20 options`。[BENCHMARKS.md]
- 主题级真实数据（各 400 例）：邮件 spam 0.993 / phishing 0.993（均在训练混合里，ECE≈0.01）、LLM guardrails 0.708–0.762（held out）、**审核 toxicity 仅 0.530（macro-F1 0.400，held out）**、支持工单 10 路 0.502–0.522。[BENCHMARKS.md]
- 多语：51 语 MASSIVE intent 上 `laya` macro 0.2269、`laya-multilingual` 0.3661（随机 0.050）；英文 doc 在非英文上**崩得很有自信**（Khmer **0.000 accuracy at 0.952 confidence**），所以路由必须在 forward 之前做。[BENCHMARKS.md]
- 校准：**两个 checkpoint 出厂都过度自信**（`laya` ECE 0.466、`laya-multilingual` 0.314，且后者**没有**拟合温度）；按 (问题类型, 选项数) 重新拟合温度后降到 0.081 / 0.106。另有 #42 之后的温度 clamp `[0.5, 5]`，因此旧 CPU sweep 的 ECE 列已过期。[BENCHMARKS.md]
- 选项顺序稳健性：0.150 / 0.040 / 0.000（三个套件），Jev 为 0.13 —— 20 选项时比 Jev 更不稳。[BENCHMARKS.md]

#### 9.1.4 安装 / 服务 / 运行时

```bash
pip install "laya[serve]"                    # 加 fastapi + uvicorn
LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve    # 默认绑 0.0.0.0:8000，预加载全部 3 个 checkpoint
# 或者：nix run .#laya-serve（flake，含 CUDA torch 二进制）
# 或 Docker quickstart：docs/docker.md
```

- 运行时：**Python 3.10+**（由 `huggingface_hub` 1.x / `transformers` 5.x / `torch` 2.14 决定），**PyTorch**（不是 Node、不是 GGUF 栈）；CPU 可跑，GPU 更快。[Laya README]
- 环境变量（`laya/serve.py` 源码表格）：`LAYA_HOST`(0.0.0.0) / `LAYA_PORT`(8000) / `LAYA_DEVICE`(auto) / `LAYA_PRELOAD`(1) / `LAYA_MODELS` / `LAYA_THREADS`（CPU 时限制 torch intra-op 线程，**别超过物理核**）/ `LAYA_AUTO_TASK`(0) / `LAYA_API_KEY`（设置后要求 Bearer）/ `LAYA_LOG_LEVEL`。[`laya/serve.py`, 2026-09-23]
- 服务端只有两个路由：`GET /health`（返回 `{status, loaded, device}`）与 `POST /v1/systemone`；`import laya.serve` 本身不碰 GPU（重依赖延迟导入）。[`laya/serve.py`]
- macOS：README 的安装章节同时给 macOS/Linux（venv + pip），但**没有 Mac/MPS 的实测数据**，`LAYA_DEVICE` 需自行指定；`[INFERENCE]` Apple Silicon 上应先试 `LAYA_DEVICE=mps`，不行再退 CPU（`LAYA_THREADS=物理核数`）。已知的 CPU 参考值：预加载后在笔记本 Ryzen 9 6900HX 上单问 **193–464 ms**；GB10 上单问 p50 100.2 ms（其中约 93 ms 是固定开销）、50 问 443.1 ms、每多一问约 +7.0 ms。[BENCHMARKS.md]
- ⚠️ 默认监听 **0.0.0.0**（与 Kev 默认 127.0.0.1 不同）：本地试用时建议显式 `LAYA_HOST=127.0.0.1`。

#### 9.1.5 `/v1/systemone` 的精确 schema（源码级）与我们客户端的兼容判定

响应由 `laya/agent.py::system_one`（`predict = system_one`）产生，`laya/serve.py` 直接把它的返回值当响应体（额外多一个 `routing` 字段）：

| 类型 | 返回字段（源码原文） |
|---|---|
| 顶层 | `{"model": "laya-rl-agent", "answers": {...}, "usage": {"input_tokens": n_tokens, "output_tokens": 0}}`（经 serve.py 再加 `routing`） |
| `choice` | `{"type": "choice", "choice": <选项 key>, "probabilities": {<key>: 4 位小数}, "confidence": <float>, "action": {"act_probability": <float>}}` |
| `score` | `{"type": "score", "score": <期望值>, "legend": {"0": <描述>, …}, "probabilities": {"0": <4 位小数>, …}, "confidence": <float>, "action": {...}}` |
| `noul` | `{"type": "noul", "noul": <P(true)>, "confidence": <max(p1, 1-p1)>, "action": {...}}` |

（来源：`https://raw.githubusercontent.com/NandhaKishorM/laya/main/laya/agent.py`，2026-09-23；`confidence_from_probs`、`action` 均为额外字段。）

对 `skills/jev-browser/lib/typesafe.mjs::normalizeAnswers` 的逐项判定：

| 我们的检查 | Laya 是否满足 | 说明 |
|---|---|---|
| `answers[id].type === questions[id].type` | ✅ | 三种类型都带 `type` |
| `noul` 为 0..1 的数 | ✅ | `noul` 字段是 P(yes)；我们自行补 `probabilities:{true,false}`，Laya 不返回该 map 也没关系 |
| `choice` 的 `probabilities` 覆盖 `criteria` 的所有 key | ✅ | 按 `q["crit"]` 的原 key 输出；缺失 key 我们本来就会补 0 |
| `choice.choice` / `confidence` | ✅ | 两者都在 |
| `score` 的 `probabilities` 键为 `"0".."n-1"` | ✅ | Laya 用 `str(i)`，与我们 `criteria.map((_, i) => String(i))` 完全一致 |
| `score.score` / `legend` | ✅ | 都在（`legend` 我们不强制读） |
| 多余字段（`action`、`routing`） | ✅ | 我们只挑已知键，忽略其余（Laya 自述其 Haskell 客户端 `hs-jev` 同样「ignores the rest」） |
| 概率归一化 | ⚠️ 无需处理 | Laya 把概率**四舍五入到 4 位小数**，和不一定精确为 1；我们的客户端不做归一化、也不因为和不等于 1 抛错，所以可接受（不要在此之上再加「概率和必须为 1」的断言） |
| 空 `questions` | ⚠️ 不会发生 | Laya 对空问题集返回空 answers 而不报错；我们本地已先在 `validateQuestions` 拦掉空问题集 |
| 鉴权 | ✅ | `LAYA_API_KEY` 未设置时不校验，我们照发 `Authorization: Bearer <key>`；设置后也匹配 |
| `model` 字段 | ✅ | 我们默认发 `jev-latest`；Laya 的 `_resolve_model` 对未知名字**当作「未指定」并自动路由**（源码注释明说 Jev 客户端的 model 字段预期 miss），不会 400 |
| 错误码 | ✅ | body 非对象或缺 `questions` → 400；模型/tokenizer 异常 → 422（我们视为不可重试的 `TypeSafeError`） |

**结论：`laya-serve` 的响应可以不改我们任何客户端代码直接用。** 接入成本不在 schema，而在「Mac 实测延迟 + 在真实 state 上的答案一致率」——见 9.4。

### 9.2 Open-Jev（`github.com/Zefan-Cai/Open-Jev`，权重 Apache-2.0 / 代码 MIT）

#### 9.2.1 它是什么

独立复现（自述 `Independent implementation inspired by TypeSafe's Jev. It does not reproduce proprietary RLCD, private weights or training data`）。技术形态：**LoRA adapter + 训练出来的 scalar decision head + 保存的校准温度**，跑在 pinned 的上游 Qwen 上；**base 权重不打包**，且**必须用 Open-Jev 自己的 loader**（`AutoPeftModel generation alone does not implement these decisions`）。[Open-Jev README, 2026-09-23；`ZefanCai/Open-Jev-2B` 的 `package/README.md`]

关键实现细节（2B 包）：`Yes-minus-No-initialized scalar head`；训练 20,204 steps × global batch 4 = **80,816 行**；**temperature = 1.5187963**（512 行 calibration 记录）；27B v1.1 的温度是 **2.5343690298472983**、LoRA rank 8。[`package/README.md`, 2026-09-20；`docs/jevbench-public.md`, 2026-09-23]

#### 9.2.2 checkpoint 与许可

| checkpoint | base（需自行 pin） | HF 包体积（usedStorage） | 温度 | 权重 license | 状态 |
|---|---|---|---|---|---|
| Open-Jev-2B | `Qwen/Qwen3.5-2B` @ `15852e8c16360a2fea060d615a32b45270f8a8fc` | 10,052,477 B（≈10 MB） | 1.5187963 | apache-2.0 | 已发布（`package/` 内含 adapter / head.pt / temperature.json / manifest） |
| Open-Jev-9B | `Qwen/Qwen3.5-9B` @ `c202236235762e1c871ad0ccb60c8ee5ba337b9a` | 23,632,005 B（≈23.6 MB） | 未在卡片列出 | apache-2.0 | 已发布，「new 9B training did not start」 |
| Open-Jev-27B-v1.1 | `Qwen/Qwen3.8-27B` | 61,930,165 B（≈62 MB） | 2.5343690298472983 | apache-2.0 | 2026-09-22 发布；**训练用四卡 FSDP2，未起过 HTTP 服务** |

许可口径：`Weights use Apache-2.0; Open-Jev source code remains MIT.`（每个 HF 仓库同时带 `LICENSE` 与 `LICENSE-CODE`）[`package/README.md`]。上游 Qwen 权重保留其自身条款；`Qwen/Qwen3.8-27B` 的许可证本次未核。

#### 9.2.3 安装 / 服务 / 文档化的限制

```bash
# 从源码起（Python 3.10+，需要 GPU）
python3 -m venv .venv && source .venv/bin/activate
python -m pip install -e '.[train]'
python -m jev.server --model Qwen/Qwen3.5-2B --revision 15852e8c16360a2fea060d615a32b45270f8a8fc --max-length 4096
# 或用发布的包
python -m jev.server --checkpoint /path/to/package/checkpoint --device cuda:0 --max-length 4096 --batch-size 1 --host 127.0.0.1 --port 8791

# Docker
docker compose up -d --build              # NVIDIA GPU；首次构建下载约 4.6 GB，镜像约 12 GB
docker compose up -d --build open-jev-cpu  # 纯 CPU（much slower，首次加载给 15 分钟启动期）
curl -s http://127.0.0.1:8791/health
```

服务路由：`GET /health`（`{status:"ready", model, method}`）、`GET /v1/models`（**`aliases: ["open-jev", "jev-latest"]`**）、`POST /v1/systemone`，另有内置 workbench / task lab / painting 静态页。[`jev/server.py` + `docker/README.md`, 2026-09-23]

「partial API compatibility, not the full hosted service」具体落在哪（文档里能确证的全部条目）：

| 项 | 文档化事实 |
|---|---|
| 请求/响应形状 | `Official /v1/systemone request/answer shape`（README 任务覆盖表）；response metadata 带 `checkpoint_sha256` |
| 服务实现 | 自己的 **stdlib `ThreadingHTTPServer`**（不是 FastAPI/uvicorn），socket timeout 30 s，请求体上限 4 MiB |
| 并发 | `Requests are serialised by a lock in the server, so one container answers one request at a time regardless of JEV_BATCH_SIZE` |
| 鉴权 / 限流 | `The server has no authentication and applies no rate limiting`（compose 只发布到 loopback） |
| 长度处理 | `JEV_MAX_LENGTH` 默认 4096；**超长直接拒绝而非截断**（`longer inputs are rejected rather than truncated`） |
| 加速路径 | `JEV_PREFIX_CACHE` 默认 off（`it exceeded the probability tolerance on 9 of 11 measured workloads`） |
| 元数据 | `code_commit: null`（镜像不含 git 历史）；27B v1.1 **没有 HTTP 服务**（FSDP2 四卡直算） |
| 未覆盖 | 官方托管的计费/多租户/并发/完整评测口径；2B/9B 的公开数字只基于 **512 行**抽样（非全量 26,452 held-out） |

仓库**没有**发布逐字段的兼容性 diff，因此「partial」的边界只能以上表为准；`[INFERENCE]` 就我们使用的三种问题类型而言，未见文档化缺口，真正的风险是「2B 起、需自家 loader 与 pinned base、Mac 无路径」。

#### 9.2.4 JevBench public（231 题，六条独立审计过的流）

| Model | Correct / 231 | Accuracy | Hard / 111 | Brier ↓ | Top-label ECE ↓ | p50（口径各异） |
|---|---|---|---|---|---|---|
| Released Open-Jev 2B | 150 | 64.94% | 46 | 0.4751 | 0.1274 | 138.0 ms（本地 H100，loopback HTTP） |
| Released Open-Jev 9B | 179 | 77.49% | 66 | 0.3219 | 0.0858 | 189.2 ms（同上） |
| Open-Jev 27B v1.1 | 197 | 85.28% | 80 | 0.2420 | 未报告 | 无 HTTP（FSDP2，不计入延迟表） |
| **Jev 1.13.0** | **200** | **86.58%** | **81** | **0.1811** | **0.0318** | 291.3 ms（托管 HTTPS） |
| GPT-5.6 Luna | 206 | 89.18% | 89 | 0.2074 | 0.0932 | 953.8 ms |
| GPT-6 Astra | 231 | 100.00% | 111 | 0.0085 | 0.0149 | 2206.4 ms |

（来源：`docs/jevbench-public.md`, 2026-09-23。作者同时声明：native 概率与 GPT 的「口头化概率」不可直接比；139 个 Choice 里有 119 个的候选顺序不同，所以这不是 fully order-controlled 的对比。）
另一个内部口径（512 行抽样，非全量）：2B 在 `calibrated_test` 上 hard-label 0.917021 / ECE 0.0203，`calibrated_ood` 0.878099 / 0.0785。[`package/README.md`, 2026-09-20]

### 9.3 SemIf 与 kev-agent-kit 各一行

- **SemIf（MIT）**：**是模型引擎，不是模型**——它把「渲染 prompt + 读选项 logits」这套逻辑做成 Python 包与 `semif-score` CLI，**在进程内加载模型**（PyTorch/CUDA、`--device mps`、`--backend mlx`、或 `--backend llamacpp --gguf …` 走本地 GGUF）；没有 HTTP 服务、没有 `/v1/systemone`，所以**不能**用 baseUrl 指过去，但它可以做我们要自己写的那层 adapter 的参考实现与校准脚本（per-workload 温度拟合）。运行时：Python 3.10+，`pip install -e '.[test,mlx]'` 或 `.[test,llamacpp]`。[SemIf README, 2026-09-23]
- **kev-agent-kit / kev-mcp（Apache-2.0，Busy-Office）**：也不实现模型——它把上游 `kev.serve` 装进 Docker（`Dockerfile.cpu` + `compose.yaml`），再提供一个 **stdio MCP server**（`integrations/kev-mcp`，3 个 MCP 工具）去查询**本地 Kev API（默认 `http://127.0.0.1:8008`）**，并附带把配置写进 `~/.codex/config.toml`、`~/.claude.json`、`~/.gemini/config/mcp_config.json` 的全局安装器；运行时要求 Docker Compose + uv + Python 3.12+ + Node 20+，首次启动下载 **0.5B** checkpoint，其徽章与卡片覆盖 0.5b/0.6b/4b/8b（即绑定的是 Qwen3 世代）。[repo README, 2026-09-23；glama.ai 的 kev-mcp 条目]
  可复用点：要么直接用它那套 compose 作为 Kev 宿主，要么（更干净）继续用上游 `kev.serve`——两者都是同一个 HTTP 契约，我们的客户端只看 baseUrl。

### 9.4 裁定表

| | Kev-0.8B | Laya-421M（`laya` / `laya-typed-decisions`） | Open-Jev-2B | SemIf |
|---|---|---|---|---|
| **sub-1B?** | ✅ 873M base + 43 MB adapter | ✅ 421M（多语档 322M） | ❌ 2B 起（另有 9B / 27B） | —（不是模型；默认 4B 基线） |
| **license** | Apache-2.0（+ Qwen base Apache-2.0） | Apache-2.0（标签含 `commercial-use`） | 权重 Apache-2.0 / 代码 MIT（base 需 pin 上游） | MIT（代码；权重不含） |
| **说 `/v1/systemone`?** | ✅ 官方声明并作为主契约 | ✅ 源码级实现（`laya/serve.py`），响应与 Jev 字段同形 | ✅ 但仅「partial」：无鉴权/限流、串行锁、超长拒绝、自有 stdlib server | ❌ 只有 CLI/库 |
| **Mac 无 GPU 可跑?** | ✅（Qwen3.5 系自动走 MLX；Qwen3 世代走 MPS）；延迟口径待自测 | ⚠️ 理论上可以（Python+torch，CPU 预加载 193–464 ms/问），但 **Mac/MPS 无官方数据**，必须实测 | ⚠️ 仅 Docker CPU 变体，作者标 `much slower`（15 min 启动期）；实用前提是有 NVIDIA GPU | ✅（`--backend mlx` / `--device mps` / llamacpp CPU） |
| **质量 vs Jev** | 域外 0.652/0.684，Brier 0.499/0.460，coverage@5% 仅 0.23（Jev 0.857 / 0.211 / 0.70）；第三方 900 张工单上 Kev-9B 反超 Jev | typed-decisions 0.766 vs Jev 0.727（**其自身训练 split**）；banking77 0.492 vs 0.870；多语 0.366 macro；出厂过度自信（ECE 0.314–0.466） | JevBench 150/231（64.94%）vs Jev 200/231；Brier 0.4751 vs 0.1811 | 见 §3 表（4B：authored 0.813 / WANLI 0.637 / TypeSafe 子集 0.845 vs Jev 0.883） |
| **接成第二后端?** | **默认后端（已选定）** | **值得接**：schema 已确认可直接吃，且能补 Kev 的短板（多语、低延迟、无 GPU 档、option 数 ≤20 的短选项场景）；前置条件=在 Mac 与我们的真实 state 上各跑一批，确认「延迟 + 与 Kev/Jev 的 top 答案一致率」 | **不建议**：2B 起、需自家 loader 与 pinned base、Mac 无实用路径；保留为协议/质量对照物 | **不接线**；复用其方法（选项槽单 token 校验、per-workload 温度拟合）与脚本 |

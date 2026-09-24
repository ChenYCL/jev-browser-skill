# 本地 Kev 后端接入（bring-up 实测）

目标：在本机（Apple M3 Max / 48 GB / macOS 25.6.0 arm64）把 [jaredpalmer/kev](https://github.com/jaredpalmer/kev)
跑成一个完全本地的 System One 服务，供 `jev-browser` skill 既有的 `/v1/systemone` 契约直接使用。
本文件只记录 **实测数据 + 逐字输出**；产品代码改动留给 phase 2。

- 机器：M3 Max / 48 GB / macOS 25.6.0
- 工具链：`uv 0.12.17`、`node v26.9.0`、repo `.python-version=3.13`（uv 实际取 `cpython-3.13.15-macos-aarch64-none`）
- Kev 检出位置（**故意放在本仓库之外**）：`~/.local/share/jev-browser/kev`
- 实测日期：2026-09-23

---

## 0. 指标一览

| 项 | 数值 | 说明 |
|---|---|---|
| `git clone --depth 1` | **32 s** | 仓库 227 MB（含 `.git` 27 MB） |
| `uv sync --extra serve` | **58 s** | `.venv` 落盘 **1.0 GB** |
| 首次启动 → 首个健康响应 | **≈ 96 s** | 含首次权重下载（supervisor 观测 `uptime=1m36s`） |
| 首次权重下载体积 | **≈ 1.72 GiB** | 基座 1,746,942,600 B + LoRA 43,338,624 B + 分词器 ~33 MB + head 2.1 MB |
| RSS（python 子进程） | **21–129 MiB 间波动** | 观测 128,960 KB，空闲后回落到 21,392 KB；MLX mmap 权重按需换页，非常驻 |
| 服务端后端 / 精度 | `backend=mlx`, `dtype=bfloat16`, `device=mps` | 默认即最优，无需配置 |
| 真实浏览器步负载（29,919 B / 8,411 input tokens） | 冷 **8.55 s** / 热 **2.78–3.37 s** | 见 §4 |
| 本地成本 | **$0** | 无 API key；`TYPESAFE_API_KEY=local` 占位即可 |
| 契约兼容性 | **通过** | `judge`/`pick` 退出码 0，无 validation/parse 错误 |
| 判断可用性 | **没有任何配置可用** | 0.8B 恒 ≈0.88 假成功；T=1.0 反而更差；4B 当时取不到（2026-09-24 已解决，见 §11）⇒ 本行只对 0.8B/0.6B 成立；**4B 已测且可用**：20 题 **19/20 = 0.95**（发布行上限下 18/20）、真实 fixture 页 `goal_done` **0.0607**、阈值带 **0.341–0.683**，见 `experiments/kev-4b/README.md` |
| 可行 `goalDone` 阈值区间 | **0.008（T=2.41）/ 0.001（T=1.0）** | 均低于噪声 ⇒ 调阈值修不好，必须改判定逻辑；见 §10.1 —— 这是 **0.8B** 的区间；**4B 的可用带是 0.341–0.683**（同为 15 个 run 回放，`experiments/kev-4b/threshold-replay.mjs`） |
| `kev-4b` | **已获取并校验（2026-09-24）** | 适配器 159.7 MB / 58 s（2.486 MB/s）；基座 9.34 GB 走 ModelScope 双流 ~22.5 min；服务已跑通（T=2.1435）；见 §11 |

---

## 1. 克隆与依赖同步

```bash
mkdir -p ~/.local/share/jev-browser
git clone --depth 1 https://github.com/jaredpalmer/kev.git ~/.local/share/jev-browser/kev
uv sync --extra serve --project ~/.local/share/jev-browser/kev
```

```
CLONE_SECONDS=32
227M    ~/.local/share/jev-browser/kev          # 含 .git 27M
SYNC_EXIT=0 SYNC_SECONDS=58
1.0G    ~/.local/share/jev-browser/kev/.venv
```

`serve` extra 实测关键依赖：`torch==2.8.0`、`transformers==5.17.0`、`peft==0.21`、
`mlx-lm`（darwin/arm64）、`fastapi`、`uvicorn==0.53.0`、`typesafe-sdk==0.6.0`。

> **坑 1**：`uv sync` 用 `.python-version`（3.13），不是系统 python3.12。
> `requires-python = ">=3.12,<3.14"` —— 别用 3.14（torch 无 wheel）。

---

## 2. 启动

### 2.1 brief 里的命令会直接报错（`--host` 不存在）

```bash
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8008 --host 127.0.0.1
```

```
usage: serve.py [-h] [--run RUN] [--fallback FALLBACK] [--port PORT]
serve.py: error: unrecognized arguments: --host 127.0.0.1
EXIT=2
```

原因（`kev/serve.py` 的 `main()`）只定义了 `--run` / `--fallback` / `--port`，host 硬编码：

```python
import uvicorn
uvicorn.run(app, host="127.0.0.1", port=a.port)
```

**`--host` 必须去掉**；监听地址永远是 `127.0.0.1`。

### 2.2 可用命令

```bash
cd ~/.local/share/jev-browser/kev
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8008
```

跳过 `uv run` 开销（**坑 3**：`uv run` 每次约 49 s）：

```bash
~/.local/share/jev-browser/kev/.venv/bin/python -m kev.serve --run jaredpalmer/kev-0.8b --port 8008
```

脱离终端 + 落盘日志：

```bash
cd ~/.local/share/jev-browser/kev
nohup ~/.local/share/jev-browser/kev/.venv/bin/python -m kev.serve \
  --run jaredpalmer/kev-0.8b --port 8008 \
  >> ~/.local/share/jev-browser/work/kev-serve.log 2>&1 &
echo $! > ~/.local/share/jev-browser/work/kev.pid
```

本次实测实际由 harness 进程管理器拉起（`hub start name=kev`），所以本会话有两个 PID：
`uv` 包装进程 **56298**、真正服务的 python 子进程 **56489**（日志经 supervisor 捕获，内容同上）。

### 2.3 启动日志

```
Fetching 9 files: 100%|██████████| 9/9 [00:17<00:00,  3.39s/it]
Downloading bytes: ██████████| 49.0MB, 4.67MB/s   Download complete: 49.0MB
Warning: You are sending unauthenticated requests to the HF Hub.
         Please set a HF_TOKEN to enable higher rate limits and faster downloads.
[kev: ready; cursor=70365]

serving jaredpalmer/kev-0.8b (<cache path>) on mps via mlx (bfloat16) :8008
```

### 2.4 首次下载体积（**坑 2**：不能用 repo 目录量）

HF 新版 Xet 布局把大文件放 **共享** 的 `hub/blobs/xx/…`，每个 repo 目录只剩符号链接和元数据，
所以 `du -sh models--Qwen--Qwen3.5-0.8B-Base` 只有 9.7 MB —— 那是假象。真实体积：

```
1.6G  ~/.cache/huggingface/hub/blobs/0a/0a75…   # 1,746,942,600 B  Qwen3.5-0.8B 基座权重
 41M  ~/.cache/huggingface/hub/blobs/3f/3f95…   #    43,338,624 B  LoRA adapter_model.safetensors
 19M  ~/.cache/huggingface/hub/blobs/77/777b…   #    19,989,325 B  基座 tokenizer.json
 12M  ~/.cache/huggingface/hub/blobs/59/5903…   #    12,807,196 B  adapter tokenizer.json
2.0M  ~/.cache/huggingface/hub/blobs/b5/b54e…   #     2,103,103 B  head.pt
```

合计 ≈ **1.72 GiB**（另有 `~/.cache/huggingface/xet` 36 MB 分片暂存）。

> `--fallback` 默认 `runs/smoke`：`--run` 既非 hub id、本地又无 `<run>/head.pt` 时，
> 会**静默回落**并打印 `… not found, falling back to …`（**坑 7**）。

---

## 3. 契约验证

### 3.1 `GET /v1/models`

```bash
curl -s http://127.0.0.1:8008/v1/models | jq .
```

```json
{
  "models": [
    {
      "name": "kev-latest",
      "description": "Kev pointer head on Qwen/Qwen3.5-0.8B-Base, serving jaredpalmer/kev-0.8b at temperature 2.41",
      "release_date": "2026-09-21",
      "run": "jaredpalmer/kev-0.8b",
      "base": "Qwen/Qwen3.5-0.8B-Base",
      "lora": 16,
      "device": "mps",
      "backend": "mlx",
      "dtype": "bfloat16",
      "temperature": 2.406050072164233,
      "prefix_cache": { "size": 4, "min_state_tokens": 0, "hits": 0, "misses": 0, "cached_states": 0 }
    },
    { "name": "jev-latest", "…": "同上，同一 checkpoint 的第二个别名" }
  ]
}
```

- 只注册 `kev-latest` / `jev-latest`（`serve.py: MODEL_NAMES`）。
- **`jev-latest` 正是 skill CLI 的默认 model** → 零配置命中。

### 3.2 `POST /v1/systemone` 接受哪些 model id

`SystemOneRequest.model: str = "kev-latest"` —— **无白名单校验**，任何字符串都收，只原样回显：

| 请求 `model` | HTTP | 回显 |
|---|---|---|
| `kev-latest` | 200 | `"model":"kev-latest"` |
| `jev-latest` | 200 | `"model":"jev-latest"` |
| `kev-0.8b` | 200 | `"model":"kev-0.8b"` |

> `kev-0.8b` **不会**切换 checkpoint（服务只加载 `--run` 指定的那个），只是回显（**坑 6**）。

### 3.3 noul + choice + score 批量返回（逐字）

```json
{"model":"kev-latest","answers":{
  "department":{"type":"choice","choice":"returns","confidence":0.0809,
                "probabilities":{"returns":0.3873,"shipping":0.3767,"billing":0.236}},
  "escalate":{"type":"noul","noul":0.5878},
  "frustration":{"type":"score","score":1.2876,
                 "legend":{"0":"Calm","1":"Frustrated","2":"Very angry"},
                 "probabilities":{"0":0.0418,"1":0.6288,"2":0.3294},"confidence":0.8144}},
 "usage":{"input_tokens":101,"output_tokens":181},"latency_ms":10280.8}
```

**结论：`lib/typesafe.mjs` 的 `normalizeAnswers()` 可原样消费**，字段逐项对齐：

| `normalizeAnswers` 需要 | Kev 返回 |
|---|---|
| `answer.type === question.type` | ✅ 每个答案带 `type` |
| noul: `answer.noul` ∈ [0,1] | ✅ |
| choice: `probabilities` / `choice` / `confidence` | ✅ |
| score: `probabilities` / `score` / `legend` / `confidence` | ✅ |
| `usage.input_tokens` / `output_tokens` | ✅ 顶层 `usage` |

其它实测：
- 响应头带 `x-typesafe-request-id`。
- `usage.output_tokens` 统计**序列化答案**的 token 数（100 选项的 choice 会到 1,520），不是生成量；
  skill 只按 input token 计费，口径一致。
- `KEV_API_KEY` 未设置时服务**开放**；skill 总带 `Authorization: Bearer <key>`，故 `local` 占位够用。
- 非法 `type` 返回 422（FastAPI 校验），空 `questions` 同样 422 —— skill 侧 `validateQuestions()` 已提前拦截。

---

## 4. 延迟：冷 vs 热（真实浏览器步负载）

负载取自 skill 真实首步（不花 API 钱）：

```bash
node skills/jev-browser/bin/jev-browser.mjs run --dry-run --json \
  --goal "the Wikipedia article about Ada Lovelace is shown" --url https://en.wikipedia.org
```

- **payload 29,919 B**（`state` + `questions`）→ 服务端 **8,411 input / 1,520 output tokens**
- 问题集：`goal_done`(noul) + `blocker`(6 选项) + `action`(4 选项) + `click_target`(**100 选项**)
- skill 自估 7,765 input tokens ≈ $0.00033；服务端实际 8,411 —— 同量级

同一 payload 连续回放：

| 次序 | HTTP | 端到端 | 服务端 `latency_ms` | 说明 |
|---|---|---|---|---|
| 1 | 200 | **8.810 s** | 8,550.5 | 冷（MLX kernel 编译） |
| 2 | 200 | **3.367 s** | 3,238.5 | 热（state 前缀缓存命中） |
| 3 | 200 | **2.852 s** | 2,775.3 | 热 |
| 4（`model=kev-0.8b`） | 200 | **2.946 s** | 2,869.9 | 同 state，命中同一前缀缓存 |

四次返回**逐字节一致**（确定性，无采样）。

其它：
- 启动后**第一次**调用即便 payload 很小也要 ~10.9 s（一次性 warm-up），之后 0.16 s。
- 前缀缓存 `size=4`：被小 payload 挤掉后重算同一大 state 回到 **15.88 s**。
  真实 browse 每步 state 都在变 → **每步基本按冷/半冷算**。

---

## 5. 加速：本机实际生效的路径

默认值（除 `--run` 外零配置）就是本机最优：`device=mps backend=mlx dtype=bfloat16`。
Kev 在 Apple Silicon 上默认走 MLX（`serve.py` 里 `opts.backend="auto"`，hybrid Qwen3.5 → MLX），
与官方 README 的 "Serving Performance" 一致。

### A) `KEV_BACKEND=torch`

```
KEV_BACKEND=torch .venv/bin/python -m kev.serve --run jaredpalmer/kev-0.8b --port 8010
```

- 状态 **ready**，`/v1/models` 200，推理 200；小批量首次推理 **37.34 s**
- 逐字警告（两条都会出现）：

```
[transformers] `causal_conv1d_fn` is falling back to its reference PyTorch implementation
because `causal_conv1d` is not installed. This is correct but much slower; install
`causal_conv1d` for the optimized version.

[transformers] `chunk_gated_delta_rule` is falling back to its reference PyTorch implementation
because `flash-linear-attention` is not installed. This is correct but much slower; install
`flash-linear-attention` for the optimized version.
```

### B) `KEV_DTYPE=fp32`（文档里的"精确评估路径"）

- **ready**，推理 200，小批量 **8.35 s**（torch 路径，kernel 已预热）；同样两条 fallback 警告
- 语义：`KEV_DTYPE=fp32` 会顺带把 backend 切到 `torch`
  （`checkpoint.py`：`exact = opts.dtype is torch.float32` → 返回 `"torch"`，**坑 10**）

**两条非 MLX 路径都不报错**——只是慢。MLX 是唯一值得用的加速路径。

> 退出时另有无害警告：`resource_tracker: There appear to be 1 leaked semaphore objects …`。

---

## 6. 端到端（通过 skill）

```bash
export TYPESAFE_API_KEY=local
export TYPESAFE_BASE_URL=http://127.0.0.1:8008
```

### 6.1 `judge` —— 退出码 0，**无 validation/parse 错误**

```json
{
  "model": "jev-latest",
  "answers": {
    "urgent": { "type": "noul", "noul": 0.578 },
    "team": { "type": "choice", "choice": "returns", "confidence": 0.1068,
              "probabilities": { "returns": 0.4045, "shipping": 0.3771, "billing": 0.2184 } },
    "frustration": { "type": "score", "score": 1.2986,
                     "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
                     "probabilities": { "0": 0.0349, "1": 0.6316, "2": 0.3335 }, "confidence": 0.8158 }
  },
  "usage": { "input_tokens": 102, "output_tokens": 180 },
  "costUsd": 0.000004284, "ms": 2039
}
```

`judge_exit=0` —— 契约真的对得上，客户端一行没改。

### 6.2 `pick` —— 退出码 0，且答对

```json
{ "choice": "pricing", "confidence": 0.9167,
  "ranked": [["pricing",0.9375],["none",0.0587],["docs",0.0026],["blog",0.0012]],
  "usage": { "input_tokens": 58, "output_tokens": 74 }, "costUsd": 0.000002436 }
```

`pick_exit=0`。短 state + 少选项的判断，0.8B 表现**正常**（3 选 1 精确命中 pricing 0.94）。

### 6.3 `doctor` —— 退出码 0，本地后端被正确识别

```
✔ typesafe api       http://127.0.0.1:8008 → models: kev-latest, jev-latest; configured model: jev-latest
✔ ego-browser cli    ego-browser ego-browser 0.5.1.11
✔ ego lite app       /Applications/ego lite.app
✔ chrome             /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
✔ safaridriver       Included with Safari 26.6.2
doctor_exit=0
```

skill 既有 `doctor` **无需改动**即可验证本地 Kev（只需 `GET /v1/models` 通）。

### 6.4 真实 browse run

**Run A — chrome headless**

```bash
node skills/jev-browser/bin/jev-browser.mjs run --backend chrome --headless --no-keep --json \
  --goal "the Wikipedia article about Ada Lovelace is shown" --url https://en.wikipedia.org --max-steps 8
```

```
backend=chrome model=jev-latest maxSteps=8 budget=$0.25
chrome launched (pid 43061, cdp http://127.0.0.1:61763, headless)
observed https://en.wikipedia.org/wiki/Main_Page (100 elements)
step 1: goal_done=0.88 blocker=none(0.35) action=click(0.46) cost=$0.0004
```

```json
{ "status": "success", "steps": 1, "goalDoneProbability": 0.8821,
  "finalUrl": "https://en.wikipedia.org/wiki/Main_Page",
  "finalTitle": "Wikipedia, the free encyclopedia",
  "usage": { "requests": 1, "cacheHits": 0, "inputTokens": 8406, "outputTokens": 1512,
             "costUsd": 0.000353, "ms": 5903 },
  "elapsedMs": 11115 }
```

**EXIT=0，wall 17 s**。

**Run B — ego，同目标**

```
backend=ego model=jev-latest maxSteps=8 budget=$0.25
ego task space 27, page p1
observed https://en.wikipedia.org/wiki/Main_Page (100 elements)
step 1: goal_done=0.89 blocker=none(0.35) action=click(0.43) cost=$0.0004
```

`status=success, steps=1, goalDoneProbability=0.8921`，**EXIT=0，wall 12 s**。

**Run C — ego，一个明确需要动手的目标**

```bash
--goal "Search Wikipedia for the Ada Lovelace article and open it" --input "query=Ada Lovelace"
```

```
step 1: goal_done=0.89 blocker=none(0.41) action=click(0.44)
status=success, steps=1, goalDoneProbability=0.8896
```

**EXIT=0，wall 12 s**。

三次都**没有 validation / parse 错误、没有异常退出**（schema 全对）——
**但三次全是假成功。**

### 6.5 诚实结论：判断质量

三次都停在 `en.wikipedia.org/wiki/Main_Page`（首页，**不是** Ada Lovelace 词条），
模型却给出 `goal_done ≈ 0.88–0.89`，超过 skill 的 `thresholds.goalDone = 0.85`，
于是控制器在第 1 步、**零动作**的情况下宣布 `success`。

对照实验（**同一问题、同一 instructions，只换 state**）：

| state | 真实情况 | Kev-0.8B `goal_done` |
|---|---|---|
| 203 tokens，Wikipedia 首页 | **未完成** | **0.792** |
| 225 tokens，"Ada Lovelace - Wikipedia" | 已完成 | 0.903 |
| 8,411 tokens，真实浏览器步 | **未完成** | **0.895** |

模型对"完成 / 未完成"**几乎不做区分**（0.79 vs 0.90），所以
**Kev-0.8B 在 skill 的 `goal_done` 问题上不可用**：不是 prompt 太长淹没，是模型/标定问题。

- 官方 model card 写了同一边界：非训练域准确率 **0.652**，"Probabilities are usable in-domain;
  treat them as advisory elsewhere"。
- 0.8B 还带一个拟合出的 `temperature=2.41`，把概率整体压向 0.8–0.9 区间（`KEV_TEMPERATURE=1.0` 可关）。
- 退化是**针对性的**：短 state + 少选项（§6.2）正常；长结构化 state + 大量候选项时最差——
  `click_target` 的 top-2 是 `e1` 0.231 / `e28` 0.216，**几乎掷硬币**。

对 `run` 的影响是致命的：`goal_done` 恒高 ⇒ 永远第 1 步"成功"，
`blocker` / `action` / `click_target` 的判断**根本没机会被执行**。

---

## 7. `jaredpalmer/kev-0.6b`（Qwen3 基座）对照

触发条件：0.8B 机械上可用、但判断质量不可用（§6.5），故按 brief 补测更小的 0.6B。

```bash
--run jaredpalmer/kev-0.6b --port 8012
```

```
{"name":"kev-latest","description":"Kev pointer head on Qwen/Qwen3-0.6B-Base, serving jaredpalmer/kev-0.6b at temperature 1.00",
 "device":"mps","backend":"torch","dtype":"bfloat16","temperature":1.0}
```

就绪耗时 **40.2 s**（Qwen3 是 attention-only，走 torch/MPS，**不用 MLX**）。探针对照：

| 探针 | kev-0.8b（T=2.41, mlx） | **kev-0.6b（T=1.00, torch）** |
|---|---|---|
| tiny state，**未完成** | 0.792 | **0.810** |
| tiny state，已完成 | 0.903 | **0.9874** |
| 小批量 3 问 `department` | `returns` 0.387 | **`billing` 0.512** |
| 真实 8.4k workload `goal_done` | **0.895**（> 阈值 → 假成功） | **0.5877**（< 阈值） |
| 真实 workload 延迟 | 冷 8.55 s / 热 2.8 s | **16.72 s** |

**Run D — ego + kev-0.6b，与 Run A/B 完全相同的目标**

```
backend=ego model=jev-latest maxSteps=5 budget=$0.25
ego task space 30, page p1
observed https://en.wikipedia.org/wiki/Main_Page (100 elements)
step 1: goal_done=0.53 blocker=none(0.98) action=click(0.64) cost=$0.0004
  → clicked link 'Full article...' → https://en.wikipedia.org/wiki/Mary_Mallon
step 2: goal_done=0.89 blocker=none(0.97) action=click(0.63) cost=$0.0007
```

```json
{ "status": "success", "steps": 2, "goalDoneProbability": 0.8917,
  "finalUrl": "https://en.wikipedia.org/wiki/Mary_Mallon",
  "finalTitle": "Mary Mallon - Wikipedia",
  "usage": { "requests": 2, "cacheHits": 0, "inputTokens": 16852, "outputTokens": 3218,
             "costUsd": 0.000708, "ms": 28327 },
  "elapsedMs": 59537 }
```

**EXIT=0，wall 63 s。**

结论：
- 0.6B 在 step 1 给出 0.53（低于阈值）→ **没有立刻假成功，确实动手了**；
  但它点的是首页轮播的 `Full article...`，跳到**当天的特色条目 Mary Mallon**（不是 Ada Lovelace），
  然后在 step 2 又把错误页面判成 0.89 → 仍然假成功，只是把失败推迟了一步。
- 0.6B 仍然**不区分**完成/未完成（0.81 vs 0.99）；温度 1.0 没被压扁，所以数值更极端。
- 0.6B 在真实负载上**更慢**（16.7 s vs 2.8 s 热）：Qwen3 基座走 torch + 两条 reference fallback，吃不到 MLX。
- 官方数字也支持：0.6B 非训练域 0.620 < 0.8B 0.652。

**所以 0.6B 不是解法**——它把"一步假成功"换成"两步假成功 + 慢 6 倍"。
真正要修的是标定/阈值/模型规模（README 家族表：4B 非训练域 0.797，9B 0.822）。

---

## 8. 坑清单（gotchas）

1. **`--host` 不存在** → `serve.py: error: unrecognized arguments: --host 127.0.0.1`（EXIT=2）；host 永远 `127.0.0.1`。
2. **HF Xet 布局**：大权重在共享 `hub/blobs/xx/…`，repo 目录 `du` 只有几 MB；真实总量 ≈ 1.72 GiB。
3. **`uv run` 每次约 49 s**（即便 venv 与模型已就绪）；反复重启请直接用 `.venv/bin/python`。
4. **首次推理 ~8.5–11 s**（MLX kernel warm-up），与 payload 大小无关；warm 后 0.16 s（小 payload）。
5. **前缀缓存只有 4 个 state**（`KEV_PREFIX_CACHE=4`, `min_state_tokens=0`）；被挤掉后重算 15.9 s。
6. **`model` 不校验、只回显**：`kev-0.8b` 也返回 200，但不切模型；只有 `--run` 决定 checkpoint。
7. **`--fallback runs/smoke`**：`--run` 指错时**静默回落**，只打印一行提示。
8. **未认证下载警告**：`Warning: You are sending unauthenticated requests to the HF Hub.`（不设 `HF_TOKEN` 也能跑）。
9. **非 MLX 路径的两条 reference fallback 警告**（`causal_conv1d`、`flash-linear-attention` 未装）是"慢"，不是错误。
10. **`KEV_DTYPE=fp32` 会顺带把 backend 切到 torch**（不是"MLX 上的 fp32"）。
11. 退出时有 `resource_tracker: … 1 leaked semaphore objects …` 警告，无害。
12. 服务默认**无鉴权**（`KEV_API_KEY` 未设置），只听 `127.0.0.1`。
13. 0.8B 的 `temperature=2.41` 是 checkpoint 内拟合值（存在 `head.pt`）；`KEV_TEMPERATURE=1.0` 才给原始 logits。
14. 选 0.8B 时 **MLX 是唯一值得用的后端**；`KEV_BACKEND=torch` / `KEV_DTYPE=fp32` 都能跑但慢一个量级。

---

## 9. 停止命令

本会话实际使用（supervisor 管理，名字 `kev` / `kev06b`）：

```bash
hub stop kev
hub stop kev06b          # 若曾启动 0.6B
```

若按 §2.2 的 `nohup` 方式起：

```bash
kill "$(cat ~/.local/share/jev-browser/work/kev.pid)"
```

兜底（按命令行匹配）：

```bash
pkill -f "kev.serve --run jaredpalmer/kev-0.8b --port 8008"
pkill -f "kev.serve --run jaredpalmer/kev-0.6b --port 8012"
```

---

## 10. 质量矩阵：checkpoint × temperature（phase 1b，有界 ≤40 请求）

问题：是否存在 **任何** 本地配置，能让模型在本 skill 的问题集上做出可用判断？
下面只放决策所需的数字（原始概率）。

### 10.1 A) 温度：`kev-0.8b` × {T=2.41 服务默认, T=1.0 原始 logits}

T=1.0 服务器（`/v1/models` 已确认 `"temperature":1.0`）：

```bash
KEV_TEMPERATURE=1.0 .venv/bin/python -m kev.serve --run jaredpalmer/kev-0.8b --port 8014
```

| 探针 | T=2.41（8008） | T=1.0（8014） |
|---|---|---|
| tiny state，**未完成** → `goal_done` | **0.792** | **0.9615** |
| tiny state，已完成 → `goal_done` | 0.903 | 0.9953 |
| real 8,411-token，**未完成** → `goal_done` | **0.895** | **0.9943** |
| real `click_target` top-2 | `e1` 0.231 / `e28` 0.216（差 0.015） | `e1` 0.5176 / `e28` 0.4428（差 **0.075**） |
| real `action` | click 0.467 / scroll_down 0.285 / stop 0.227 / wait 0.022 | click 0.676 / scroll_down 0.205 / stop 0.119 / wait 0.0004 |
| real `blocker` | none 0.350 / error_page 0.257 / missing_info 0.192 | none 0.564 / error_page 0.268 / missing_info 0.133 |
| batch `department` | returns 0.387 / shipping 0.377 / billing 0.236 | returns 0.447 / shipping 0.418 / billing 0.136 |
| batch `escalate` (noul) | 0.588 | 0.701 |
| batch `frustration` (score) | Frustrated 0.629 / Very angry 0.329 | Frustrated 0.825 / Very angry 0.174 |
| judge `team` | returns 0.4045 / shipping 0.3771 / billing 0.2184 | returns 0.4828 / shipping 0.4077 / billing 0.1095 |
| judge `urgent` (noul) | 0.578 | 0.681 |
| pick `pricing` | 0.9375 | **0.9987** |
| real workload 延迟 | 冷 8.55 s / 热 2.78–3.24 s | 冷 7.12 s / 热 2.70 s |

**T=1.0 不能恢复可用分离度**——它把分布整体"锐化"（click 间距 0.015→0.075、pick 0.9375→0.9987），
但 `goal_done` 的 done/not-done 间距反而从 **0.111 缩到 0.034**：

| 温度 | not-done 取值 | done 取值 | 可放进阈值区间 | 区间宽度 |
|---|---|---|---|---|
| T=2.41 | {0.792, 0.895} | {0.903} | (0.895, 0.903) | **0.008**（纯噪声） |
| T=1.0 | {0.9615, **0.9943**} | {0.9953} | (0.9943, 0.9953) | **0.001** |

**没有任何阈值能把"未完成"和"已完成"分开**，两个温度都不行。

另一个负面结论：tiny 控制组（203 tokens）本身就是 0.792 / 0.9615，
所以 **observation trimming 救不了 `goal_done`** —— 不是长 state 淹没了模型，缩短 observation 只会省延迟。

### 10.2 B) `kev-4b`：**根本拉不下来**（决定性结果，逐字）

> **2026-09-24 更新：本节结论已被复测推翻。** 4B 权重已完整下载并通过 sha256 校验，
> `kev.serve --run jaredpalmer/kev-4b` 已在本机跑通（服务卡上报 temperature 2.1435）—— 见 §11。
> 下面的逐字记录保留为当时的现场证据，不要再据此认为 4B「取不到」。

```bash
.venv/bin/python -m kev.serve --run jaredpalmer/kev-4b --port 8014
```

supervisor 逐字：

```
Started kev4b: starting pid=33609 uptime=25m restarts=0
NOT ready — readiness timed out after 1500s: port 8014 on 127.0.0.1 never accepted connections.
The process is still running (state: starting); follow its logs or stop it.
```

28 分钟后实际落盘：

```
$ du -sk ~/.cache/huggingface/hub/models--jaredpalmer--kev-4b
4508                      # 4.4 MB（adapter repo 自身未完成）
$ find …/models--jaredpalmer--kev-4b -name "*.incomplete" -exec du -h {} +
 48K  …/blobs/9797de69….778e91df.incomplete      # 在传文件定格 48 KB
```

同一时刻对 `hub/blobs` 与 `xet` 取两次样（间隔 25 s）：**零增长**。
日志显示的是**重试循环**（`Fetching 13 files` 反复重建），瞬时速率只有 **5–40 kB/s**：

```
Fetching 13 files:   0%|          | 0/13 [00:00<?, ?it/s]
Warning: You are sending unauthenticated requests to the HF Hub.
         Please set a HF_TOKEN to enable higher rate limits and faster downloads.
Reconstructing (incomplete total...):   0%|            | 81.1kB /  140MB
Downloading bytes: ███▌ | 68.5MB, 8.78kB/s
Downloading bytes: ████ | 70.0MB, 15.9kB/s
[kev4b: starting; cursor=537787]
```

对照：0.8B 首次下载 1.72 GiB 只用 ~96 s（≈18 MB/s）。4B 的基座约 **8.1 GB**，
按 25 kB/s 需要 **~90 小时** —— `--run jaredpalmer/kev-4b` 在本机/本网络下**不可行**。

因此 **4B 的任何探针都测不了**：没有 `goal_done` / `click_target` / browse run 数据。
不是"效果不好"，是"取不到"。按指示，**不再去找别的模型**（zero-Python fallback 是另一个 worker 的活）。

### 10.3 C) 判定表：{kev-0.8b, kev-4b} × {T=1.0, T=2.41}

| 配置 | done / not-done（tiny） | 分离度 | real workload 的 not-done | 可用？ |
|---|---|---|---|---|
| `kev-0.8b` T=2.41 | 0.903 / 0.792 | 0.111 | **0.895** → 第 1 步假成功 | **否** |
| `kev-0.8b` T=1.0 | 0.9953 / 0.9615 | **0.034** | **0.9943** → 更严重假成功 | **否（更差）** |
| `kev-4b` T=2.41（实测为其自带 T=2.1435） | 未测（未做 tiny 探针） | 未测 | 真实 fixture 页 **0.0607**（0.8B 是 0.6952 假成功） | **是（19/20 = 0.95）**：阈值带 0.341–0.683、`click_target` 2/2；见 `experiments/kev-4b/README.md` |
| `kev-4b` T=1.0 | 未测 | — | 未测 | 未测（4B 在自身温度下已可用；上行为实测值） |
| （参考）`kev-0.6b` T=1.0 (torch) | 0.9874 / 0.810 | 0.177 | 0.5877 → 多走一步后仍假成功（Run D） | **否** |

**判定依据 = 可行阈值区间的宽度**：
T=2.41 是 **0.008**、T=1.0 是 **0.001**、4B 当时无法测量（现已可下载，见 §11）。三者都低于噪声水平
⇒ **0.8B / 0.6B 任何配置都不能让模型在本 skill 的问题集上做出可用判断。**

> **2026-09-24 更新：4B 已测，结论只对 0.8B/0.6B 成立。** `jaredpalmer/kev-4b` 在同一 20 条自明真值上
> **19/20 = 0.95**（发布行上限下 18/20），真实 fixture 页 `goal_done` **0.0607**（0.8B 是 0.6952 的假成功），
> 同一 15 个 run 回放的可用带是 **0.341–0.683**（0.482 处 7 正确 / 0 假成功 / 0 假 stuck）—— 即 **4B 可以驱动 run**。
> 代价与命令见 `experiments/kev-4b/README.md`；技能侧已按后端自动选阈值（`thresholds.profile`，
> 见 `skills/jev-browser/references/config.md`）。**下面的 least-bad 建议仅适用于继续使用 0.8B 的情况。**

若要保留一条本地默认（工程上的"least bad"）：

- **checkpoint**：`jaredpalmer/kev-0.8b` —— 当时唯一能稳定下载（1.72 GiB / 96 s）并启动的；4B 现已同样可用（§11），见上面的更新
- **temperature**：保持服务默认 **T=2.41**（不要设 `KEV_TEMPERATURE=1.0`，分离度反而更差）
- **threshold**：**不要动阈值**。可行区间 0.008 属噪声，调阈值不可能修好；必须改**判定逻辑**
- **observation trimming**：**不解决 `goal_done`**（203-token 控制组已经是 0.792/0.9615），只用来省延迟
- **因此**：本地 Kev 只适合**短 state 的辅助判断**（`pick` 0.94–0.9987、短 choice 稳定），
  `goal_done` 必须交给**确定性检查**（URL/title/文本谓词），或把 Kev 降级为"继续/停止"的次要信号

### 10.4 D) 收尾与 PID

| 服务器 | 端口 | PID | 状态 |
|---|---|---|---|
| `kev-0.8b`（T=2.41，默认） | **8008** | 56298 (uv) / **56489** (python) | **保留运行**（`GET /v1/models` → 200） |
| `kev-0.8b`（T=1.0） | 8014 | 3999 | 已停 · exit=1 · uptime 1m40s |
| `kev-0.6b`（T=1.0, torch） | 8012 | 23234 (uv) / 23774 (python) | 已停 · exit=143 · uptime 11m18s |
| `kev-4b`（下载卡死） | 8014 | 33609 | 已停 · exit=1 · uptime 27m39s |

收尾后：8012 / 8014 均不可达，仅 8008 存活。

---

## 11. Kev-4B 权重：发布状态复测 + 落盘（2026-09-24）

§10.2 曾把 `jaredpalmer/kev-4b` 记为「无法获取」（28 min 只落盘 4.4 MB，5–40 kB/s，推 ~90 h）。
**这个结论不成立**：仓库是完整的，本次把适配器与基座全部下载下来并逐文件校验通过，服务也跑通了。
原读数的成因有两条，但只有第一条是本次实测证实的：① 5 MiB 窗口正好落在 TCP 爬坡段（前 ~20 s，见 §11.5 表）；
② 当时走的是 hf_hub 的下载路径（含 Xet 客户端）—— 本次在同一链接上没复现出卡死（§11.5 的 A/B），
所以当年那次 28 min 的读数与 curl 不是同一测量口径，不能互相外推。本次用 `curl` + 64 MiB 窗口复测：

- 同一链接上所有来源 64 MiB 窗口都在 **1.56–2.27 MB/s**（HF 系）与 **5.54–5.70 MB/s**（ModelScope）；
- 适配器 129,924,032 B **实际下载 2.486 MB/s、58 s 完成**（此前 28 min 未完成）；
- 结论：仓库完整、可下载；此前「拿不到」的判断不成立。

### 11.1 发布状态（只读 HTTP）

| 来源 | 文件 | 字节 | sha256 / LFS oid | HEAD | ranged GET |
|---|---|---|---|---|---|
| HF `jaredpalmer/kev-4b` (main `485ace87…`) | `adapter_model.safetensors` | 129,924,032 | `9797de69…df2b`（LFS oid，下载后本地 shasum 复核一致） | 302 → `us.aws.cdn.hf.co/xet-bridge-us/…` → **200**，`accept-ranges: bytes` | ✅ 206 |
| 同上 | `head.pt` | 5,248,767 | `d8f796da…721d6a` | 200 | ✅（本地已校验） |
| 同上 | `tokenizer.json` | 19,989,325 | `06b95093…e523` | 200 | ✅ |
| 同上 | 其余 13 个小文件（含 `adapter_config.json`、`vocab.json`、`merges.txt`、`README.md`） | 合计 4,548,065 | git blob oid 校验 | 200 | ✅ |
| 同上（合计） | **16 文件** | **159,710,189** | 全部本地校验通过 | — | — |
| GitHub release `kev-family` | `kev-4b.tar.gz` | 129,125,088 | `bd8581d4…a151`（`SHA256SUMS.txt` 公布） | 200（asset API） | ✅ 206，2.040 MB/s |
| 同上 | `kev-4b-v7-base.tar.gz` | 129,132,360 | `81ebaf81…ec2` | 200 | — |
| 同上 | `kev-4b-qwen3.tar.gz` | 131,245,471 | `01d3dc8e…7769` | 200 | — |
| 同上 | `SHA256SUMS.txt` | 768 | — | 200 | ✅（内容已记录） |
| `hf-mirror.com` | 同 HF 路径 | 同 HF | — | **308 → huggingface.co → 同一 CDN**（不是独立镜像） | ✅ 206 |
| ModelScope | `jaredpalmer/kev-4b` | — | — | **不存在**（`/api/v1/models/...` 404；网页 URL 只回 SPA 壳，200 不算托管证据） | ✗ |
| ModelScope | `Qwen/Qwen3.5-4B-Base` | shard1 5,329,398,712 / shard2 3,990,429,344 | 与 HF LFS oid 逐字一致 | **200** | ✅ 206 |

> GitHub 的 tar.gz 是压缩容器，与 HF 仓库的文件体积不可直接对比；完整性以 `SHA256SUMS.txt` 为准。
> 「上传过」的逐字证据在 HF 提交历史里：`2026-09-20T22:46:04Z Kev-4B: Qwen3.5-4B-Base, decision-v7 recipe …`、
> `2026-09-21T11:13:43Z Kev-4B: dates+unknowable delta on the v7 checkpoint … previous weights at tag v7-base`；
> 仓库 tag `qwen3` / `v7-base` 分别指向旧世代权重，README 与 `docs/model-cards/kev-4b.md` 都按「当前家族」列出 4B。

**一行结论：4B checkpoint 是「完整上传」** —— 每个文件的大小与仓库 tree 元数据逐一相符，
129.9 MB 的 LFS 大文件端到端下载后 sha256 与 LFS oid 一致，且同一 checkpoint 另有带 `SHA256SUMS.txt` 的 GitHub release 包。

### 11.2 吞吐（`curl`，64 MiB 窗口，逐条串行；两处窗口各测一次以排除边缘效应）

| 来源 | 窗口 | MiB/s | MB/s |
|---|---|---|---|
| HF 直连 · adapter | head 0–64 MiB | 1.484 | 1.556 |
| HF 直连 · adapter | tail（倒数 64 MiB） | 1.820 | 1.909 |
| HF 直连 · base shard1 | head | 1.520 | 1.593 |
| HF 直连 · base shard1 | 深部 3 GiB 处 | 1.780 | 1.867 |
| HF 直连 · base shard2 | head | 2.163 | 2.268 |
| hf-mirror（实为跳转） · adapter | head | 1.548 | 1.623 |
| GitHub release asset `kev-4b.tar.gz` | head | 1.945 | 2.040 |
| **ModelScope · base shard1** | head | **5.282** | **5.538** |
| **ModelScope · base shard1** | 深部 3 GiB 处 | **5.439** | **5.703** |
| **ModelScope · base shard2** | head | **5.289** | **5.546** |
| HF 双流并行（shard1+shard2） | 每流 64 MiB | 1.767 / 1.765 | 聚合 3.728 |
| ModelScope 双流并行 | 每流 64 MiB | 5.436 / 5.466 | 聚合 ≈10.9 |

读数要点：所有窗口都 ≥64 MiB、都是 206 全窗口；HF 侧单流受每连接限速，加一条连接约翻倍；
ModelScope 单流就是 HF 的 3.4 倍。

> 短窗口 vs 长程：ModelScope 双流的 10.9 MB/s 来自 13 s 的探测窗口；真正的 9.34 GB 拉了 22.5 min，
> 长程聚合回落到 **~5.5–7.4 MB/s**（每流滚动均值 ~2.9 MB/s）。报数时以长程为准，短窗口只用来排序来源。

### 11.3 落盘位置与布局（`--run` 解析路径不变）

写进 HF 缓存 `~/.cache/huggingface/hub/models--jaredpalmer--kev-4b/`，**命名规则与 `hf_hub` 自己写的完全一致**：
LFS 文件在 `blobs/<lfs sha256>`、小文件在 `blobs/<git blob oid>`，另加 `trees/<commit>.json`、`refs/main`、
`snapshots/<commit>/<file>` 符号链接。（差别只在实体存放方式：hf_hub 的 Xet 模式把大文件写成
`blobs/<sha256> -> ../../blobs/<xx>/<xet-hash>` 的符号链接指向共享池，curl 落盘则是直接写实体文件；
两种形态 hf_hub 都能解析，下面这条离线解析就是证据。）因此 `kev.serve --run jaredpalmer/kev-4b` 的解析路径无需任何改动：

```
$ HF_HUB_OFFLINE=1 .venv/bin/python -c "from kev.checkpoint import resolve_run; print(resolve_run('jaredpalmer/kev-4b'))"
/Users/light/.cache/huggingface/hub/models--jaredpalmer--kev-4b/snapshots/485ace8703592fcf405488b262449990824cfed1
```

`head.pt` 逐字（来自落盘后的 checkpoint）：`base=Qwen/Qwen3.5-4B-Base`、
`base_revision=1001bb4d826a52d1f399e183466143f4da7b741b`（= 基座 main，未漂移）、`lora=16`、`head_dim=256`、
`temperature=2.1435469250725863`（in-repo 拟合值，1264 行开发集）。

> **温度有两个数，别混**：`head.pt["temperature"] = 2.1435` 是 delta 之后重拟的、**服务实际使用**的值
> （`checkpoint.py: m.head.temperature = meta.temperature`，`/v1/models` 也报这个）；
> 同一个 checkpoint 里的 `result.json["temperature"] = 2.3784` 是 delta **之前**那次 trial 的旧拟合值，
> 加载路径不读它。`KEV_TEMPERATURE=1.0` 才是关掉温度、走原始 logits。

### 11.4 基座（`Qwen/Qwen3.5-4B-Base`，13 文件 9,342,824,751 B）

（§10.2 里写的「基座 8.1 GB」是 GiB 口径的近似；实测 13 个文件合计 **9,342,824,751 B = 8.70 GiB**。）

来源选 **ModelScope**（唯一独立镜像；分片 sha256 与 HF LFS oid 逐字一致，字节仍按 HF tree 元数据命名 + 校验）。
下载方式：两个分片两条 `curl -C -` 流并行，30 s 采样一次滚动均值，低于 0.3 MB/s 即中止。

| 项 | 结果 |
|---|---|
| 文件 / 体积 | 13 文件 · **9,342,824,751 B（8.70 GiB）** |
| 分片 sha256 | shard1 `df547074…d712` ✅、shard2 `590fbaac…15ef` ✅（与 HF LFS oid 一致） |
| 分词器 / 小文件 | `tokenizer.json` `fe000e3e…9272` ✅；其余 10 个小文件按 git blob sha1 ✅ |
| 落盘位置 | `~/.cache/huggingface/hub/models--Qwen--Qwen3.5-4B-Base/`（`blobs/` + `snapshots/1001bb4d…/` + `trees/` + `refs/main`） |
| 用时 | 分片并行 ~22.5 min（job 全程含校验 1,379.9 s）；小文件 23.0 MB 另走 HF ~50 s |
| 实测速率 | 两条流各 3.88 / 3.52 MB/s（含校验耗时）；长程滚动均值 ~2.9 MB/s / 流，聚合 ~5.5–7.4 MB/s |

> 一次自家 bug 的中断：首轮 240 s 被监控线程误判中止（当时监控只统计"已完成"字节，没把 `.incomplete` 的增长算进去），
> 已修好并复跑；已落盘的 709.6 MB + 710.5 MB 由 `curl -C -` 直接续传，没有重下。
> 小文件必须来自 HF：ModelScope 的 `.gitattributes` 是 2,335 B，HF 是 1,570 B —— 用 ModelScope 下会与 HF 元数据校验不符。

### 11.5 复查原来的「判死」依据

| 原判据 | 本次复测 |
|---|---|
| 28 min 只落盘 4.4 MB | 那 4.4 MB 是**小文件 + 元数据**（本次查看缓存确认：当时 129.9 MB 的大文件只落了 45 KB 的 `.incomplete`）。同一条链接、同一个 URL，这次用 curl 跑完 129.9 MB 只用了 58 s。 |
| 速率 5–40 kB/s | 那次读数是 hf_hub 客户端在 28 min 窗口里的表现；本次 curl 在 64 MiB 窗口起手就是 1.5 MB/s。两者不是同一测量口径，不能互相外推。 |
| 「基座 8.1 GB ⇒ ~90 h」 | 90 h 是把上述坏速率线性外推的结果。实测：ModelScope 双流短窗口 ~10.9 MB/s（投影 ~14 min），长程聚合 5.5–7.4 MB/s ⇒ **实测 9.34 GB 用时 ~22.5 min**；HF 单流 1.59–2.27 MB/s ⇒ 1.1–1.6 h。 |
| 引擎差异 | 同一链接上 curl 明显快于 hf_hub 的下载路径（本次 129.9 MB 适配器：curl 58 s）；`hf_hub` 1.32 还带 Xet 客户端（`HF_HUB_DISABLE_XET=1` 可退回普通 HTTP）。本次直接绕开该路径，用 curl 传输、脚本负责续传与校验。 |

> 引擎 A/B 的诚实结论：在同一个 8,394,495 B 的 xet 文件上跑三臂 —— `hf_hub` 默认（Xet）14.7 s、
> `HF_HUB_DISABLE_XET=1` 9.0 s、`curl` 17.5 s —— **三者都落在 ~20 s 的 TCP 爬坡段内，这个实验区分不了引擎**；
> 它能证明的只有：hf_hub 的客户端现在能把这 8.4 MB 下完（不再有卡死重试循环）。
> 真正有分辨力的是大文件：curl 在 64 MiB 窗口上的 1.5–2.3 MB/s（HF）与 5.4–5.7 MB/s（ModelScope）是可复现读数。

### 11.6 操作步骤（本次实际执行的）

```bash
# 1) 适配器仓库（159.7 MB，16 文件）：curl + 逐文件 sha256/git-blob 校验，写入 HF 缓存布局
python3 experiments/kev-4b/fetch.py jaredpalmer/kev-4b

# 2) 基座两个分片（9.32 GB）：ModelScope 双流并行，各一条 curl -C -，滚动均值 <0.3 MB/s 自动中止
python3 experiments/kev-4b/fetch.py Qwen/Qwen3.5-4B-Base --source modelscope --only 'model.safetensors-00001-of-00002.safetensors' &
python3 experiments/kev-4b/fetch.py Qwen/Qwen3.5-4B-Base --source modelscope --only 'model.safetensors-00002-of-00002.safetensors' &

# 3) 基座其余 11 个小文件（23.0 MB）：必须走 HF（ModelScope 的 .gitattributes 与 HF 不同，见上）
python3 experiments/kev-4b/fetch.py Qwen/Qwen3.5-4B-Base --source hf --skip 'model.safetensors-*'
```

`fetch.py` 可重复运行：已完成的 blob 直接校验跳过，未完成的 `<sha256>.incomplete` 由 `curl -C -` 续传。
原始读数：`experiments/kev-4b/published-state.json`、`experiments/kev-4b/probe-throughput.sh`、
`experiments/kev-4b/probe-supplemental.sh`、`experiments/kev-4b/fetch*.log`。

### 11.7 端到端验证（全离线）

一次跑完 `bash experiments/kev-4b/verify.sh`，四道闸全过：

| 检查 | 结果 |
|---|---|
| 全量重校验 | 两个仓库 `verified_this_pass=True`（适配器 16 文件、基座 13 文件，逐个重算 sha256 / git blob sha1 与 Hub tree 元数据比对） |
| `resolve_run`（离线） | `jaredpalmer/kev-4b` → `…/snapshots/485ace87…`；`Qwen/Qwen3.5-4B-Base@1001bb4d…` → `…/snapshots/1001bb4d…` |
| transformers（离线） | `model_type=qwen3_5`、`num_hidden_layers=32`、`vocab=248044` |
| MLX 装配 + 前向 | 426 个权重张量加载 **16.5–22.0 s**（`backend=mlx`、`dtype=bfloat16`、`device=mps`），一次真实判定返回三个问题的概率 |

服务侧（`HF_HUB_OFFLINE=1`，即完全不需要网络）：

```bash
$ .venv/bin/python -m kev.serve --run jaredpalmer/kev-4b --port 8008
[kev: ready; cursor=…]          # 就绪 12.8 s
```

```json
// GET /v1/models
{"models":[{"name":"kev-latest","run":"jaredpalmer/kev-4b","base":"Qwen/Qwen3.5-4B-Base","lora":16,
            "device":"mps","backend":"mlx","dtype":"bfloat16","temperature":2.1435469250725863, …}]}
```

```json
// POST /v1/systemone（一张工单，choice + noul + score 三种题型）
{"answers":{"department":{"type":"choice","choice":"billing","confidence":0.9666,
                          "probabilities":{"shipping":0.0112,"billing":0.9777,"returns":0.0111}},
            "urgent":{"type":"noul","noul":0.2032},
            "frustration":{"type":"score","score":0.7401,"legend":{"0":"Calm","1":"Frustrated","2":"Very angry"},
                           "probabilities":{"0":0.3465,"1":0.5669,"2":0.0866},"confidence":0.7834}},
 "usage":{"input_tokens":117,"output_tokens":181},"latency_ms":1177.4}
```

三个答案都与题面一致（billing / 不需要当天 / 第 1 级"Frustrated"），且 `temperature` 与 `head.pt` 一致（2.1435）。
测完即停：`hub stop name=kev-4b-8008`，收尾后 8008 / 8012 / 8014 三个端口均空闲，无残留进程。

---

## 附：实测产物路径


| 文件 | 内容 |
|---|---|
| `~/.local/share/jev-browser/work/dryrun.json` | skill 真实首步 state+questions（29,919 B payload 来源） |
| `~/.local/share/jev-browser/work/req-kev-latest.json` | 回放用请求体（29,919 B） |
| `~/.local/share/jev-browser/work/batch.json` | noul + choice + score 契约样本 |
| `~/.local/share/jev-browser/work/probe-notdone.json` / `probe-done.json` | §6.5 对照实验的两种 state |
| `~/.local/share/jev-browser/work/big-{cold,warm,warm2,alt}.json` | §4 四次回放原始响应 |
| `~/.local/share/jev-browser/work/browse-{chrome,ego,ego-search}.json` | §6.4 Run A/B/C 结果 |
| `~/.local/share/jev-browser/work/browse-ego-kev06b.json` | §7 Run D 结果 |
| `~/.local/share/jev-browser/work/cfg-{torch,fp32,kev06b}.log` | §5/§7 非默认后端完整日志 |
| `~/.local/share/jev-browser/kev` | Kev 检出（含 `.venv` 1.0 GB） |




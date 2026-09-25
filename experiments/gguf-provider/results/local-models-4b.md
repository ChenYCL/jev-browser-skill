# 4B 级本地模型排名（未训练 GGUF + 首 token logprob 读出）

> 目标：把「本地 Jev」从 0.8B 抬到 4B 级，选出最佳候选。
> 状态：**三个 4B 候选全部测完；候选 1（Qwen3.5-4B Q4_K_M）仍是冠军（16/20 = 0.80）**。
> 候选 2 Qwen3-4B-Instruct-2507 **15/20 = 0.75**（差 1 题，但真实 fixture 一步把 click_target
> 选成 e4=Search）；候选 3 gemma-3-4b-it **10/20 = 0.50**（与 0.8B 同分，读出跟位置不跟内容）。
> 链路本次恢复并实测（0.87–1.16 MB/s），两个新候选的字节与 sha256 均已对齐上游。下载进程已停。
> peer 已把 registry `default` 切到候选 1 并端到端验证通过。站点：`experiments/gguf-provider/results/`。

## 0. 结论（当前）

| 模型 | 全部 20 | browser 15 | noul 5 | action+click 5 | 每题 ms mean/max | 真实 fixture 一步 | click_target（期望 e1；e4=Search 按钮） | 标签质量 mean(min) | 非单 token 标签 |
|---|---|---|---|---|---|---|---|---|---|
| **Qwen3.5-4B Q4_K_M** | **16/20 = 0.80** | 12/15 = 0.80 | 4/5 = 0.80 | 2/5 = 0.40 | 3072/13895 | **13,809 ms** | **e15 @ 0.498**（= hosted Jev 同选，非 e4） | 0.9407 (min 0.7958) | 0 |
| Qwen3-4B-Instruct-2507 Q4_K_M | 15/20 = 0.75 | 10/15 = 0.67 | 5/5 = 1.00 | 1/5 = 0.20 | 2514/15386 | 11,578 ms | e4 @ 1.000（e4=Search，错） | 0.9998 (min 0.9965) | 0 |
| gemma-3-4b-it Q4_K_M | 10/20 = 0.50 | 7/15 = 0.47 | 3/5 = 0.60 | 1/5 = 0.20 | 2189/9725 | 6,495 ms | e15 @ 0.886（= hosted Jev 同选，非 e4） | 0.7743 (min 0.0081) | 0 |
| Qwen3.5-0.8B Q8_0（现默认档） | 10/20 = 0.50 | 7/15 = 0.47 | 3/5 = 0.60 | 1/5 = 0.20 | 777/4178 | 3,111 ms | e4 @ 0.777（e4=Search，错） | 0.9950 | 0 |
| 「恒选第一个选项」基线 | 11/20 = 0.55 | 9/15 | 2/5 | 2/5 | — | — | — | — | — |
| hosted Jev（天花板） | 19/20 = 0.95 | 14/15 = 0.93 | 5/5 = 1.00 | 5/5 = 1.00 | 621/1270 | 922 ms | e15 @ 0.750 | — | — |
| **Kev 4B（`jaredpalmer/kev-4b`，T=2.1435，MLX）· 发布行上限 8192** ‡ | **18/20 = 0.90**（19 条可答 → 18/19 = 0.947） | 13/15 = 0.867 | **5/5 = 1.00** | 4/5 = 0.80 | 1965/8995 | **422（packed 超行上限）** → 分问回退：goal_done 0.0613 ✓ / blocker none / action click / select_target none | —（该题 422） | n/a（Σp mean 1.0000 / min 0.9999；near-uniform 0、coinflip 0） | n/a（无读出层） |
| **Kev 4B · `KEV_SERVE_MAX_*=16384`（本地评估补丁）** ‡ | **19/20 = 0.95** | **14/15 = 0.933** | **5/5 = 1.00** | **5/5 = 1.00** | 2223/12183 | **23,769 ms**（packed 12,073 tok）：goal_done **0.0607 ✓** / action click 0.7543 / blocker none / select_target none / **click_target e1 @ 0.2142 ✓** | **e1 @ 0.2142 ✓**（五个模型里唯一命中手写标签） | n/a（Σp 12 条全合 1，min 0.9999） | n/a（无读出层） |

> **† Kev 对照行** —— 产物 `experiments/kev-4b/`（runner + 逐题原始 JSON + README）；同一 20 条自明真值
> ＋同一真实 fixture 一步，走 skill 自身的 `/v1/systemone` 客户端路径（hosted Jev 用的同一条），
> `--run jaredpalmer/kev-0.8b` 已由 preflight 逐字核对 ⇒ 不可能静默换模型。
> - **两处结构性不可答（HTTP 422，不是答错）**：`ddg-click-target-aapl` 与真实 fixture 一步的
>   `click_target` 都被 `branch too long: 4700 tokens with a 6407-token state (row limit 8192)` 拒绝。
>   上限来自 `kev/model.py:15 SERVE_MAX_STATE, SERVE_MAX_BRANCH = 8192, 8192`（行 = state + 单分支），
>   **无 env 开关**。GGUF 侧同一 fixture 也是 11,748 tokens，靠 `llama.cpp -c 16384` 解决；Kev 没有
>   对应旋钮 ⇒ 20 条里只有 **19 条可答**（14/19 = 0.737）。`action+click` 5 题里那 2 条 click_target
>   实际 1 条可答（`wiki-login-click-target` 命中 e9）。
> - **noul 不是"卡在 0.5"，而是按 state 长度分裂**：短 passage **5/5** 且极锐（0.0070 / 0.1312 vs
>   0.9816 / 0.9859，separation **+0.936**）；浏览器 state 上**反向且贴中线**（separation **−0.120**）——
>   同一 fixture state 的 `goal_done` = **0.6952（假成功）**，而 GGUF 4B 在同一 state 上是 **0.006**；
>   两条 `submit_after_type` = **0.4594 / 0.4627**（离 0.5 只有 0.04，其中判"对"的那条正是靠 0.5 阈值蒙对）。
> - **choice 概率贴中线**：11 个 choice/score 答案里 3 个 top1−top2 ≤ 0.05（`ddg-typed-action` 0.029、
>   `github-login-type-value` 0.020、`wiki-progress` 0.0016）；`wiki-progress` 归一化熵 **0.973** 近均匀
>   （p=[0.14,0.27,0.30,0.30]，score=1.749 只因 ±0.5 落窗得分）；`action` 0.498/0.239/0.163、
>   `blocker` 0.459/0.240/0.177。
> - **概率按常规求和**：11 个 choice/score 答案 Σp mean 1.0000 / min 0.9997 / max 1.0001，0 个越界
>   —— 概率本身没有坏，坏的是分辨力。
> - **值不值得并进任何决策：不值得。** 14/20 **全靠那 5 条短 passage**：浏览器项只有 **9/14 = 0.64**
>   （GGUF 4B 是 12/15 = 0.80），而控制器最先要用的两类恰是最差（`goal_done` 0/1 假成功、
>   `click_target` 1/2 且另一个不可答）。它确实做对的类型：`blocker` 2/2（含 fixture state）、
>   `type_target` 2/3、`progress` 1/1（靠取整）、短 passage `answer` 5/5、外加 1 个 `action`
>   —— 即"短 state、少选项、非 `goal_done`"的辅助判断。与 `docs/local-kev-bringup.md` 由熵/pick
>   测试得出的"只适合短 state 辅助判断"结论一致，现在有了可比的 20 题数字。
> - **该 422 可解除，但解除后仍然错**：把 `kev/model.py` 的行上限做成 env 可配（**本机 clone 的本地评估
>   补丁**，默认值与发布一致；diff 见 `experiments/kev-4b/README.md`）后，两条 422 都消失（20/20 可答，
>   packed fixture step 4,543 ms / 12,073 input tokens，19 条原有答案逐位不变），**但准确率不变（仍
>   14/20）**：新答出的那题给 `e17 @ 0.1375`（期望 e1 排第 4 位 @ 0.0724；hosted Jev 与 GGUF 4B 都选的
>   e15 只有 0.0370），top1−top2 = **0.0059** —— 仍是掷硬币，top1−top2 ≤ 0.05 计数从 3/11 升到 4/12。
>   结构性修复买不到分辨力。
>
> **‡ Kev 4B 两行** —— 同一个 runner、同一 20 条 + 同一真实 fixture 一步，`--run jaredpalmer/kev-4b`
> 经 preflight 逐字核对（服务卡 `run`/`base=Qwen/Qwen3.5-4B-Base`/`temperature=2.1435` 全部核对过）。
> **注意这不是"未训练基座"候选**：Kev 4B 是同家族上训练过的 pointer-head checkpoint，跑在它自己的
> MLX 服务里（`HF_HUB_OFFLINE=1`，无需网络）—— 与上面四行"未训练 GGUF"不同类，但它可以在这 20 条上
> 直接对拍，所以并列在表里。
> - **它现在是本地最好的一档**：16384 下 **19/20 = 0.95**，比 GGUF 候选 1（16/20 = 0.80）**高 3 题**，
>   且与 hosted Jev 天花板 **同分（都 19/20），三个切片逐个持平**（browser 14/15、noul 5/5、
>   action+click 5/5）。16384 与 8192 两次跑过的 19 条**答案逐位相同**（行上限不动模型）。
> - **它在一个题型上真的赢过 hosted Jev**：`click_target` **2/2 vs 1/2** —— 两者唯一的分歧是
>   `ddg-click-target-aapl`，Kev 4B 给 **e1 @ 0.2142**（= 仓库手写标签，五个模型里唯一命中者；
>   hosted Jev 与 GGUF 4B 都给 e15）。反过来它在 `submit_after_type` **1/2 vs 2/2** 输给 hosted Jev
>   （`github-login-submit` 给 0.6194 → true，应为 false）。总分持平，各错一题，错在不同的题。
> - **控制器最关键的那一问被修好了**：真实 fixture state 上 `goal_done` = **0.0607**（判"未完成"，正确）
>   —— Kev 0.8B 在同 state 上是 **0.6952（假成功）**，GGUF 4B 是 0.006。浏览器 noul 的分离度从
>   0.8B 的 **−0.1196** 翻到 **+0.6107**。退化签名消失：`near-uniform` **0**、top1−top2 ≤ 0.05 **0**
>   （0.8B 分别是 1 与 4），8 条 noul 无一条贴中线，12 条 choice/score 的 Σp 全部按常规合 1
>   （min 0.9999，0 违例）。
> - **代价 = 上限与内存**：19/20 需要那个本地评估补丁（发布上限 8192 下是 18/20 = 0.90，且决定性的
>   click_target 题**答不了**）；延迟均值 2.2 s / 单题最大 **12.2 s**（55 选项那题），packed fixture 一步
>   **23.8 s / 12,073 tokens**，无一条超过 60 s。**内存是这行的真正限制**：冷启动 footprint 18–19 GB
>   （与 8192 相同，全是 `IOAccelerator` 的 GPU 内存），跑完一轮 16384 后涨到 **36 GB**，把系统
>   swap 从 16.7 GB 顶到 **28.3 GB used / 28.7 GB total（仅剩 416 MB）**；停服后回落（free 52–54%）。
>   48 GB 机器上这已是可运行的边缘，但本轮没有任何一次请求因换页超时或失败。

**★ 排名变动（本窗口）**：表里"未训练 GGUF 候选 1"（Qwen3.5-4B Q4_K_M，16/20 = 0.80）仍是**那个集合**内的
第一；但**整体最好的本地后端现在是 Kev 4B @16384 = 19/20 = 0.95**（训练过的 pointer-head checkpoint + 自己的
MLX 服务），比 GGUF 候选 1 高 3 题，并且与 hosted Jev 天花板同分、三个切片逐个持平 —— 详见表格最后两行与 ‡。

1. **4B 明显强于 0.8B，且首次越过平凡基线**：Qwen3.5-4B Q4_K_M **16/20 = 0.80**
   （0.8B 10/20 = 0.50；「恒选第一个选项」基线 11/20 = 0.55；hosted Jev 19/20 = 0.95）。
   → **是，超过 0.5**（比 0.8B 高 6 题，比基线高 5 题）。
2. **它在真实 fixture 一步上给出与 hosted Jev 相同的元素**：click_target = **e15**（Yahoo Finance 的
   AAPL 行情页）P=0.498，而不是 0.8B 选的 e4（Search 按钮）。该步 **13,809 ms**（含 11.7k-token prefill；
   且当时后台仍在下载，见 §5 延迟口径）。
   **独立复测（peer `local-backend-impl`，无下载负载、`-c 16384`）**：冷 18,298 ms、**热 9,002 ms**
   （click_target 6,135 ms，其余 4 问 630–815 ms）；选择与我们完全一致（e15@0.498、blocker none 0.873、
   action click、select_target none、goal_done 0.006）；llama-server RSS **3,362 MiB**。
   → 干净口径：**4B 一步 ≈ 9 s 热 / 18 s 冷**，其中 2/3 时间花在那道 55 选项题上。
3. **轮转测试（top candidate）：跟内容，不跟位置** —— 与 0.8B 相反：
   - wiki（100 选项）：k=0/3/7 三次全部命中正确元素（e8/e5/e1），P≈0.99；
   - ddg（55 选项）：k=0 命中 e1；k=3/k=7 改选 **e11/e7** —— 两处都是**同一个内容**
     （Yahoo Finance AAPL 行情页），即模型仍按内容选，只是它更偏好 Yahoo 而不是手写标签的
     investing.com（hosted Jev 同样选 Yahoo）。判分口径见 §4 备注。
4. **`-c 8192` 跑不动这套 20 题**（第一题就 11,748 tokens，llama-server 400
   `exceed_context_size_error`）；`-c 16384` 全绿且 `truncated = 0`。launcher 默认 16,384 正确。
5. **候选 2/3 本轮已测完（链路恢复后补测）—— 排名不变，候选 1 仍是首选：**
   - **候选 2 Qwen3-4B-Instruct-2507 = 15/20 = 0.75**（差候选 1 一题）。亮点是 noul 满分 **5/5**：
     `bq-penguins` **0.0000（候选 1 在这里错，P=0.6178）**、`bq-python` 0.0000、`bq-paris` 1.0000、
     `bq-everest` 1.0000、`bq-trap-failed` 0.0000 —— 决定极锐（标签质量 mean 0.9998 / min 0.9965，
     全部质量都落在标签上）。也命中 `wiki-login-click-target = e9`（P=1.0000）。轮转 wiki 3/3 正确
     （e8/e5/e1，跟内容）。
     **但真实 fixture 一步失手**：click_target 给 **e4 = Search（P=1.000）** —— 与 0.8B 同错，
     与 hosted Jev/候选 1 的 e15 不同；这一步 11,578 ms，action 给 `stop`（应 click），
     blocker none / select_target none / goal_done ~0 三项正确。
   - **候选 3 gemma-3-4b-it = 10/20 = 0.50** —— 与 0.8B 同分、**低于平凡基线 0.55**；
     noul 3/5（错 `bq-penguins` 0.9715、`bq-python` 0.9935），action+click 1/5。
     **轮转 6 次只中 1 次**：wiki k=0/3/7 三次都答 `e1`（只有 k=7 恰好正确）+ ddg 三次全错
     → **读出跟位置、不跟内容**，与 0.8B 同类缺陷（两个 Qwen 4B 都是跟内容的）。
     fixture 一步 6,495 ms，click_target **e15 @ 0.886（与 hosted Jev/候选 1 同选）**，
     但 action `select`、blocker `consent_or_permission_dialog`、select_target `e5` 三项错。
     标签质量 mean 0.7743 / **min 0.0081**（有一行标签质量接近塌掉）。
   - **可驱动性（上一窗口未验证的 caveat）已关闭**：两个候选的 llama-server 上
     `/apply-template` 都返回正确模板渲染（候选 2 `<|im_start|>user…<|im_end|>`，
     候选 3 `<start_of_turn>user…<end_of_turn|>`），且 20 题 + 真实一步全程 0 个 422
     （无 `LOW_LABEL_MASS`）。

## 1. 方法（与 brief 一致；唯一偏离是 `-c`，理由见 §0.4）

- 推理：`llama-server`（Homebrew llama.cpp 0.4.0 / build b10809），**一次只起一个**，
  端口 **8100**（llama-server）+ **8102**（需要时用 `serve.mjs` 适配层）；每个候选跑完即停。
  参数：`-c 16384 -ngl 99 --cache-type-k q8_0 --cache-type-v q8_0 -t 8 --jinja -np 1 --no-warmup`。
- 题目：`eval/run.mjs` 的 **20 条自明真值**（15 browser + 5 passage 是非，含轮转）＋ 真实捕获页面
  完整一步 `fixtures/judge-state.json` + `judge-questions.json`（5 问，经 `cli.mjs --request`）。
- 读出：`lib/provider.mjs` 原样（`n_predict=1`、`n_probs=512`、samplers 全关、位置标签、
  裸/空格表面形式相加、选项集合归一化）；**未改任何 `eval/**` 代码**。
- 量化：统一 `Q4_K_M`（若两候选差 ≤3 点，再补 `Q8_0`）。
- 天花板：hosted Jev（`api.typesafe.ai`，`jev-latest` → 实测 `jev-1.13.0`），同样 20 条 + 同一步 fixture。

命令（每个候选；`<file>` = `~/.jev-browser/models/` 下的 GGUF）。
下面这条协议当时包在 `/tmp/jev-ceiling/run-candidate.sh` 里——那是临时脚本，
**已随 `/tmp` 清理删除，仓库内没有副本**；重跑时按下面三步重建它（或直接逐步执行）：

```bash
# 1) 起 llama-server（一次只起一个；跑完即停）
/opt/homebrew/bin/llama-server -m ~/.jev-browser/models/<file> \
  --port 8100 -c 16384 -ngl 99 --cache-type-k q8_0 --cache-type-v q8_0 -t 8 --jinja -np 1 --no-warmup
# 2) 20 条自明真值 + 标签轮转（--url 指向上面的 llama-server）
node experiments/gguf-provider/eval/run.mjs --url http://127.0.0.1:8100 --json \
  > experiments/gguf-provider/results/eval-<slug>.json
node experiments/gguf-provider/eval/run.mjs --url http://127.0.0.1:8100 --rotate --json
# 3) 真实捕获页面的完整一步（fixtures/judge-state.json + judge-questions.json 拼成请求体）
node experiments/gguf-provider/cli.mjs --request experiments/gguf-provider/results/fixture-step-request.json \
  --url http://127.0.0.1:8100 > experiments/gguf-provider/results/fixture-step-<slug>.json
```

`run-candidate.sh` 的第三步（汇总行）就是把上面两份产物整理成 `results/analysis-<slug>.json`
的一行，口径见 §4；那部分逻辑也在被删除的临时脚本里，仓库没有留下生成器。

## 2. 候选状态

| # | 候选（HF repo） | 文件 | 量化 | 字节 | sha256(前 16) | 状态 |
|---|---|---|---|---|---|---|
| 1 | `unsloth/Qwen3.5-4B-GGUF` | `Qwen3.5-4B-Q4_K_M.gguf` | Q4_K_M | 2,740,937,888 | `00fe7986ff5f6b46` | ✅ **已测（16/20）** |
| 2 | `unsloth/Qwen3-4B-Instruct-2507-GGUF` | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | Q4_K_M | 2,497,281,120 | `3605803b982cb64a` | ✅ **已测（15/20）**：在 928,294,448 B 处断点续传，1.163 MB/s 补完 |
| 3 | `unsloth/gemma-3-4b-it-GGUF` | `gemma-3-4b-it-Q4_K_M.gguf` | Q4_K_M | 2,489,894,016 | `04a43a22e8d2003d` | ✅ **已测（10/20）**：在 201,995,056 B 处断点续传，0.933 MB/s 补完 |
| 4 | Phi-4-mini-instruct | `microsoft_Phi-4-mini-instruct-Q4_K_M.gguf` | Q4_K_M | ~2.3 GB | — | ⏸ 探索项 |
| 5 | Llama-3.2-3B-Instruct / SmolLM3-3B | — | — | — | — | ⏸ 探索项 |

已下载字节合计：**7.73 GB**（候选 1 2.74 GB + 候选 2 2.497 GB + 候选 3 2.490 GB；三者都通过
size + sha256 全套校验，证据见 §5）；`~/.jev-browser/models/` 现有
`Qwen3.5-4B-Q4_K_M.gguf`（2.74 GB）、`Qwen3-4B-Instruct-2507-Q4_K_M.gguf`（2.497 GB）、
`gemma-3-4b-it-Q4_K_M.gguf`（2.490 GB）与 `Qwen3.5-0.8B-Q8_0.gguf`（812 MB）。
hf `.cache` 只剩 6 MB 旧分片 —— 928 MB / 202 MB 两个大分片已在安装时被改名消耗掉，没有留下垃圾。

### 2.1 候选 1 逐题（20 条）

见 `analysis-qwen35-4b.json` / `eval-qwen35-4b.json`（含轮转）。要点：

- 命中（16）：ddg action/blocker/goal_done/typed-submit/type_target、**wiki-login-click-target = e9（唯一
  「Log in」链接，mass 0.9965）**、wiki type_target、github type_target/value/submit/blocker、
  wiki progress（score 2.035，p=[0.03,0.02,0.84,0.11]）、5 条 passage 中的 4 条（paris/python/everest/trap）；
- 未命中（4）：`ddg-click-target-aapl`（选 e15，标签争议见下）、`ddg-typed-action`（click 而应为 type）、
  `github-login-action`（wait 而应为 type）、`bq-penguins`（true 而应为 false，P=0.6178）；
- `noul` 不再是常量：`bq-python` 0.3427（false）、`bq-everest` 0.9602（true）、
  `bq-trap-failed` 0.4416（false ✓）、`goal_done` 0.006（false ✓）、`bq-penguins` 0.6178（MISS）。
- **置信度这次是可用的弃权信号**（与 0.8B 相反）：12 个 choice/score 答案 mean conf 0.516，
  错答 mean 0.233（最自信的错答只有 0.598）→ 阈值化后：
  `conf ≥ 0.5` 覆盖 8/12、其中 7/8 正确（0.88）；`conf ≥ 0.7` 覆盖 4/12、4/4 正确（1.00）。
  （对照 0.8B：错答均值 0.700 vs 全量 0.766，几乎无法区分。）
- 100 选项题的尾部标签有 32 个落出 top-512（1/20 行受影响），其余行标签质量 ≥0.7958。

### 2.2 候选 2 逐题（20 条）

见 `analysis-qwen3-4b-instruct-2507.json` / `eval-qwen3-4b-instruct-2507.json`（含轮转）。要点：

- 命中（15）：`ddg-goal-done-aapl`、`ddg-typed-type-target`、**`wiki-login-click-target` = e9（P=1.0000）**、
  `wiki-typed-type-target`、`github-login-type-target`/`type-value`/`submit`、`github-login-blocker`、
  `wiki-progress`（score 2.0000）、**noul 5/5**（paris 1.0000 / everest 1.0000 / trap 0.0000 /
  **penguins 0.0000** / **python 0.0000**）；
- 未命中（5）：`ddg-click-target-aapl`（**e4 @ P=1.000** —— 与 0.8B 同错，e4 是 Search 按钮）、
  `ddg-action-aapl`（stop）、`ddg-typed-action`（wait）、`ddg-typed-submit`（P=0.097）、
  `github-login-action`（wait）；
- **决定极锐**：标签质量 mean 0.9998 / min 0.9965，noul 的答案全是 1.0000/0.0000 —— 与候选 1 的分散分布相反；
- 轮转：wiki 3/3 正确（e8/e5/e1，跟内容）；ddg k=0 正确（e1）、k=3/7 选 e11/e7
  （两处同为 Yahoo 系内容，与候选 1 相同的内容偏好）。

### 2.3 候选 3 逐题（20 条）

见 `analysis-gemma-3-4b-it.json` / `eval-gemma-3-4b-it.json`（含轮转）。要点：

- 命中（10）：`ddg-goal-done-aapl`、`ddg-typed-type-target`、`wiki-typed-type-target`、
  `github-login-{action,blocker,submit}`、`wiki-progress`、noul 3/5（paris/everest/trap）；
- 未命中（10）：`ddg-click-target-aapl`（e15 @ 0.029）、`ddg-action-aapl`（select）、
  `ddg-blocker-aapl`（consent_or_permission_dialog）、`ddg-typed-action`（select）、`ddg-typed-submit`、
  `wiki-login-click-target`（e1）、`github-login-type-target`（e5）、`github-login-type-value`（password）、
  `bq-penguins`（0.9715）、`bq-python`（0.9935）；
- **轮转 6 次只中 1 次**：wiki k=0/3/7 三次都答 `e1`（只有 k=7 恰好正确），ddg 三次全错
  → **读位置不读内容**（与 0.8B 同类，两个 Qwen 4B 都是读内容的）；
- 标签质量 mean 0.7743 / **min 0.0081**：有一行质量近乎塌掉（对照候选 2 的 min 0.9965）。

## 3. 裁定（本次窗口）

- **排名（三个 4B 全部测完）**：**候选 1 Qwen3.5-4B Q4_K_M 第一，16/20 = 0.80**；
  候选 2 Qwen3-4B-Instruct-2507 **15/20 = 0.75**；候选 3 gemma-3-4b-it **10/20 = 0.50**
  （与 0.8B 同分、低于平凡基线 11/20 = 0.55）；hosted Jev 天花板 19/20 = 0.95。
  → **没有候选超过 0.80，首选不变**，registry `default` 无需改动。
  > **限定（后续窗口）**：这句只对**未训练 GGUF 候选集合**成立。**Kev 4B**（训练过的 checkpoint，
  > 自己的 MLX 服务）已越过它：**19/20 = 0.95**，与 hosted Jev 同分、三切片持平，并在 `click_target`
  > 上以 2/2 赢过 hosted Jev（1/2）—— 见 §0 表格最后两行与 ‡。registry `default` 仍指 GGUF 那条
  > 独立服务路径，两者并存不冲突。
- **是否超过 0.5？候选 1（0.80）与候选 2（0.75）是，候选 3（0.50）不是。**
- **候选 2 差一题，但差在最要命的那一步**：准确率只差 1 题，且 noul 满分（唯一压住 `bq-penguins`
  的模型），但在真实 fixture 一步上 click_target 给 **e4 = Search（P=1.000）**，与 0.8B 同错 ——
  高分没有换来可用的浏览器动作；候选 1 在这一步与 hosted Jev 同选 e15。
- **候选 3 不合格**：与 0.8B 同分、轮转 1/6（跟位置不跟内容）、标签质量 min 0.0081。
- **可驱动性 caveat 已关闭**：候选 2/3 的 `/apply-template` 均返回正确模板渲染，
  20 题 + 真实一步全程 0 个 422 —— 上一窗口「未验证」的说法不再成立（见 §0.5）。
- **候选 4/5（Phi-4-mini-instruct、Llama-3.2-3B / SmolLM3-3B）：本轮 1.5 h 预算内未开始。**
- **落地不变**：registry `default` 仍是 `qwen3.5-4b-q4-k-m`（peer `local-backend-impl` 已端到端验证
  launcher + `/health` + fixture judge）；0.8B 保留为「更快但更弱」档。

本轮未做的可选补测（**需要单独预算**，不是本轮遗漏）：

```bash
# 候选 2 与候选 1 只差 1 题（≤3 点）→ 早先 brief 约定补 Q5_K_M/Q8_0 对拍；每个量化 ~2.5-3 GB。
# 驱动脚本 /tmp/jev-ceiling/run-candidate.sh 与 make-table.mjs 已随 /tmp 清理删除（仓库无副本），
# 重跑 = 重建：llama-server + §1 的两步 eval/cli 命令，再用 §4 口径汇总。
/opt/homebrew/bin/llama-server -m ~/.jev-browser/models/<file> --port 8100 -c 16384 \
  -ngl 99 --cache-type-k q8_0 --cache-type-v q8_0 -t 8 --jinja -np 1 --no-warmup
node experiments/gguf-provider/eval/run.mjs --url http://127.0.0.1:8100 --json
node experiments/gguf-provider/cli.mjs --request experiments/gguf-provider/results/fixture-step-request.json \
  --url http://127.0.0.1:8100
# 汇总（make-table.mjs 已删除）：按 §4 口径把 eval/fixture 产物整理成 §2 表的一行。
# 当时的调用是：node /tmp/jev-ceiling/make-table.mjs qwen35-4b qwen3-4b-instruct-2507 gemma-3-4b-it qwen35-08b-c16384
```

（上表两行新数据由 `make-table.mjs` 机械复算过，与手写行逐格一致；`eval/**` 代码一行未改。
该脚本是临时工具，现已不在本机。）

## 4. 备注与判分口径

- **`ddg-click-target-aapl` 标签有争议**：仓库手写标签期望 `e1`（investing.com 结果，
  捕获时 `in_viewport=false`），而 hosted Jev、候选 1 与候选 3 都选 `e15`（Yahoo Finance AAPL 行情页，
  `in_viewport=true`）。两者都算「AAPL 行情」来源 → 该题严格计分让这些模型被低估 ≤1 题。
  **但这不救候选 2**：它给的是 `e4`（Search 按钮，P=1.000，对 e1 的 P=0.0001），不是 e15。
- **延迟口径（三个候选的测温条件不同，读表要看这一条）**：
  候选 1 与候选 3 是**后台正在下载**时测的 → 偏悲观（候选 1 均值 3,072 / 最大 13,895 / fixture 13,809 ms；
  候选 3 均值 2,189 / 最大 9,725 / fixture 6,495 ms）；**候选 2 是在所有下载结束后测的干净口径**
  （均值 2,514 / 最大 15,386 / fixture 11,578 ms）。所以候选 2 的均值低于候选 1 并不代表它更快 ——
  同条件下候选 1 的独立复测是冷 18,298 / 热 9,002 ms（见 §0.2）。下载现已全部结束，
  候选 1/3 若要对齐条件可复测（本轮 1.5 h 预算内未做）。
- 标签质量：候选 1 mean 0.9407 / min 0.7958，候选 2 **0.9998 / 0.9965**，候选 3 0.7743 / **0.0081**。
  候选 1 的分散分布不是缺陷（不是位置先验那种一点集中）；候选 2 的极锐分布伴随「noul 全对」是强信号，
  但它的 fixture click_target 也以 P=1.000 选错，说明**高 mass 不等于高正确率**。
- **非单 token 标签：三个候选均为 0**（`multi_token_labels` 全空），字母表校验按预期工作。

## 5. 网络证据（本次实验的硬约束）

| 时间 | 现象 | 实测 |
|---|---|---|
| 23:10–23:37 | 全 WAN 极慢 | HF 9.6–11.5 KB/s、hf-mirror 7.8 KB/s、Cloudflare 11.5 KB/s、GitHub 3 B/s、tuna 23 KB/s、aliyun 10.7 KB/s、modelscope 1.7 KB/s、经本机代理(Surge 6152) 8.3 KB/s |
| 23:37–00:40 | 恢复 | HF **1.0–2.45 MB/s**（候选 1 下完 2.74 GB） |
| 00:40 之后 | 再次 flapping | 30 s 窗口内 `.cache` 与 xet CAS 双侧 0 KB/s；候选 2 停在 309 MB |
| 全程 | 小请求正常 | `huggingface.co` 元数据 API、`api.typesafe.ai` 均正常 → 不是断网，是吞吐被压 |

旁证：peer `local-backend-impl` 独立测得 ~8 KB/s 并中止过自己的 774 MiB 下载；`kev4b` 日志
15–60 KB/s 后放弃；无 HF token（未认证），`hf_transfer` 已装但无改善。

### 5.1 本轮（09-24 01:00–02:15）复测

| 时间 | 现象 | 实测 |
|---|---|---|
| 00:50–01:05 | **短窗口会误判链路** | 5 MiB 分段抓取只报 0.21–0.35 MB/s；但同一 URL 的 20 MiB / 150 MiB 窗口显示吞吐在前 ~20 s 从 0.13 爬到 0.9 → 150 MiB 实测 **稳态 0.87–0.93 MB/s**（后 10 s 1.11，峰值 1.6）。**上一窗口的「~0.2 MB/s」是 slow-start 读数，不是链路真实速度** —— 这是候选 2/3 被误丢的直接原因 |
| 01:04–01:09 | node fetch vs curl（同链路、同 URL、同一时刻） | node/undici 稳定 **0.35 MB/s**，curl **0.72–0.93 MB/s** → 下载引擎改用 curl；`--noproxy '*'` 仍解析到同一个 fake-IP `198.18.7.191`，说明代理对两条路径都透明，**没有「绕过代理」的旁路** |
| 01:09–01:48 | 候选 3 下载（curl 引擎，39 min） | 201,995,056 B 断点续传，**0.933 MB/s** 补完 2.19 GB |
| 01:49–02:11 | 候选 2 下载（curl 引擎，22.5 min） | 928,294,448 B 断点续传（按要求未重下），**1.163 MB/s** 补完 1.569 GB |
| 01:04–02:11 | 0.3 MB/s 中止规则 | **一次都没触发**（10 分钟滚动窗口始终高于下限）；全程无 stall、无重连、无重试 |

### 5.2 落盘校验（进 llama-server 之前的硬门）

| 文件 | 字节（= 上游） | sha256（= HF LFS 元数据） |
|---|---|---|
| `gemma-3-4b-it-Q4_K_M.gguf` | 2,489,894,016 ✅ | `04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19` ✅ |
| `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | 2,497,281,120 ✅ | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` ✅ |

两个 digest 都算了**两遍**（下载器在安装前算一遍、`shasum -a 256` 在落盘后独立再算一遍），
都等于上游 LFS sha256；`llama-server /props` 另报 `Q4_K - Medium`、`-c 16384`、chat template 在位。
→ **本轮没有任何截断/错位的 GGUF 到达 llama-server**（这正是上一窗口浪费掉的那个失效模式）。

## 6. registry 字段（供 `local-backend-impl` 直接引用）

| slug | bare filename | resolve URL | bytes | label |
|---|---|---|---|---|
| `qwen35-4b` | `Qwen3.5-4B-Q4_K_M.gguf` | `https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf` | 2,740,937,888 | `Qwen3.5-4B Q4_K_M` |
| `qwen35-08b` | `Qwen3.5-0.8B-Q8_0.gguf` | `https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf` | 811,843,840 | `Qwen3.5-0.8B Q8_0` |

（机器可读版：`results/candidates.json`。）

## 7. 本次留下的文件

```
results/ceiling-jev-20items.json / .log           hosted Jev 20 条（19/20）
results/ceiling-jev-fixture-step.json             hosted Jev 真实 fixture 一步（922 ms，e15@0.75）
results/eval-qwen35-4b.json / .log                候选 1：20 条 + 轮转
results/fixture-step-qwen35-4b.json / .log        候选 1：真实 fixture 一步（13,809 ms，e15@0.498）
results/analysis-qwen35-4b.json                   候选 1 汇总行（表格数据源）
results/eval-qwen35-08b-c8192.json / .log         0.8B @ -c 8192：400 exceed_context_size_error（11,748 tok）
results/eval-qwen35-08b-c16384.json / .log        0.8B 参考行（10/20）
results/fixture-step-qwen35-08b-c16384.json/.log  0.8B fixture 一步（3,111 ms，e4@0.777）
results/fixture-step-request.json                 由 fixtures/ 拼出的 systemone 请求（5 问）
results/baseline-first-option.json                平凡基线（11/20）
results/candidates.json                           候选元数据（filename/url/bytes/sha256/label；本轮新增候选 2/3）
results/download-*.log                            下载日志（含网络停滞证据）
results/fetch-gemma-3-4b-it.log                   本轮：候选 3 受监督下载日志（断点续传/速率/校验）
results/fetch-qwen3-4b-instruct-2507.log          本轮：候选 2 受监督下载日志（从 928 MB 分片续起）
results/eval-gemma-3-4b-it.json / .log            本轮：候选 3 20 条 + 轮转
results/fixture-step-gemma-3-4b-it.json           本轮：候选 3 真实 fixture 一步（6,495 ms，e15@0.886）
results/analysis-gemma-3-4b-it.json               本轮：候选 3 汇总行
results/eval-qwen3-4b-instruct-2507.json / .log   本轮：候选 2 20 条 + 轮转
results/fixture-step-qwen3-4b-instruct-2507.json  本轮：候选 2 真实 fixture 一步（11,578 ms，e4@1.000）
results/analysis-qwen3-4b-instruct-2507.json      本轮：候选 2 汇总行
results/throughput-2026-09-24.json                本轮：5 MiB 窗口实测（两个 repo）
results/ramp-qwen-2026-09-24.json                 本轮：150 MiB 采样窗口（候选 2 URL）
results/ramp-gemma-2026-09-24.json                本轮：20 MiB 采样窗口（候选 3 URL）
results/ramp-gemma-sustained-2026-09-24.json      本轮：150 MiB 采样窗口（候选 3 URL）
results/throughput-summary-2026-09-24.json        本轮：链路汇总 + 每候选 ETA
```

本轮新增的**仓库内**工具（上一窗口的临时工具当时在 `/tmp/jev-ceiling/`，现已删除）：

```
lab/fetch.mjs        受监督下载器：curl 引擎、hf 分片断点续传、0.3 MB/s 十分钟中止规则、sha256 硬门
lab/throughput.sh    定长分段抓取的吞吐探针
lab/ramp.mjs         采样式速率探针（把 slow start 和稳态区分开 —— 本轮结论的关键工具）
```

临时工具（**从未入库，且已随 `/tmp` 清理从本机删除，无法恢复**）：
`/tmp/jev-ceiling/{ceiling-run,analyze,make-table,gguf-meta}.mjs`、
`/tmp/jev-ceiling/run-candidate.sh`、`/tmp/jev-ceiling/fetch-4b.sh`。
`run-candidate.sh` 就是 §1 每候选跑的那条协议，等价重建步骤见 §1 的命令块
（`eval/run.mjs` + `cli.mjs --request`，都在仓库内）；`fetch-4b.sh` 的下载逻辑
已由仓库内的 `lab/fetch.mjs` 覆盖（断点续传 + sha256 硬门）。

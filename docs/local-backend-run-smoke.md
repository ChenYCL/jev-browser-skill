# 本地后端「真跑一轮」实测：`jev-browser run` 能不能被本地模型驱动完成

目标：回答一个此前从未测过的问题 —— 本地 GGUF 后端（`node skills/jev-browser/bin/jev-local.mjs`）
除了能回答单次 judge，能不能被 `jev-browser run` 的 code controller 真正驱动，跑完一整轮浏览器任务。

- 机器：M3 Max / 48 GB / macOS 25.6.0 arm64，node v26.9.0，`llama-server` 0.4.0（Homebrew）
- 后端：本机全本地 `Qwen3.5-4B-Q4_K_M`（registry 默认项），llama-server `:8090` + Jev 契约服务 `:8092`
- 浏览器：`--backend chrome --headless`（每次 run 独立 profile，可复现）
- 实测日期：2026-09-24
- 原始件（15 个 journal、16 项校准探针、39 步请求日志）当时在 `/tmp/jev-local-smoke/`，**该目录已随 `/tmp` 清理删除，且从未入库**——下面的数字都来自当时的现场记录，原始 journal 无法再回放
- **`skills/**` 与 `docs/**` 之外一行未改：§6 列出的观测/代码层问题只报告、不改动，本次也没有提交任何 commit**

---

## 0. 结论（先说结果）

**能跑完，但不能可靠地「自己判断跑完了」。**

| 问题 | 答案 |
|---|---|
| 本地后端能被 `run` 驱动到 `success` 吗？ | **能**：R7 在真实站点（Wikipedia 搜索结果页，64 个可点选项）4 步达成 `status=success`、退出码 0；另有 3 次 1 步达成（example.com / 商品页 / 目录页） |
| 传输层/契约层有没有坏？ | **没有**：39 个步骤请求全部首次尝试即成功（`attempts` 全为 1）、0 次超时、0 次 422 `LOW_LABEL_MASS`（最低 label_mass 0.870，阈值 0.5） |
| 15 次 run 的结局 | `success` 4 · `stuck` 8 · `needs_user` 2 · `max_steps` 1（无 `error`、无 `timeout`） |
| 卡点在哪 | 不是选元素（`click_target`），而是 **`action` 选择** 与 **`goal_done` 语义**：9 个非 `success` 的 run 里，8 个的失败点都是 `action` 把 `stop`/`click`/`wait`/`go_back` 排在正确动作前面，剩下 1 个（R3）是 `type` 结构上没被提供 |
| `goal_done >= 0.85` 这条终止规则本地能不能用 | **阈值 0.85 是错的值，不是错的问题**：按终止语义（首次越线即 success，§9）**`goal_done >= 0.25`（可用带 0.12–0.28）7/7 正确 success、0 假 success、0 假 stuck**；现行 0.85 只有 4/7 且假 stuck 3 次。逐「步」分类确实不可分（达成 0.058–0.995 vs 未达成 ≤0.111），代码侧替代（实体/环检测）更差（各 4 次假 success） |

判定边界（详见 §8）：
- **可用**：`judge` 单问、`click_target` 选元素、「当前页面是不是已经是目标状态」这一问；
- **不可用**：把 `run` 的 `success` 终止交给 `goal_done`（动作型目标会漏判成 `stuck`）、`action` 动作选择（需要填表/输入时几乎必错）、`blocker` 在表单/报价页上的判定（会假 `needs_user`）。

---

## 1. 环境与启动（逐字）

```bash
# 本地后端（8090 llama-server + 8092 jev 契约服务）；启动器只复用「同一个 gguf」的已启动实例
node skills/jev-browser/bin/jev-local.mjs
# → [local] model ready: ~/.jev-browser/models/Qwen3.5-4B-Q4_K_M.gguf (2.6 GiB)
# → [local] llama-server: /opt/homebrew/bin/llama-server
# → [local] starting llama-server: ... -m .../Qwen3.5-4B-Q4_K_M.gguf --host 127.0.0.1 --port 8090 -c 16384 -ngl 99 --cache-type-k q8_0 --cache-type-v q8_0 -t 8
# → [local] llama.cpp serving on http://127.0.0.1:8090 (pid 38548, -c 16384)
# → [local] serving /v1/systemone on http://127.0.0.1:8092 (qwen3.5-4b-q4-k-m · Qwen3.5-4B Q4_K_M); Ctrl-C to stop
# → TYPESAFE_BASE_URL=http://127.0.0.1:8092 TYPESAFE_API_KEY=local
```

模型加载 2.7 s（Metal），服务就绪后 `/health` 返回 `{"status":"ok","service":"jev-local","model":"qwen3.5-4b-q4-k-m"}`。

```bash
# fixture 站点（tests/fixtures/server.mjs，固定 3111 端口）
node --input-type=module -e "const {createSite}=await import('./tests/fixtures/server.mjs');const s=createSite();await new Promise(r=>s.server.listen(3111,'127.0.0.1',r));"
```

每次 run 的环境（覆盖仓库外的 user config，不写仓库）：

```bash
export TYPESAFE_BASE_URL=http://127.0.0.1:8092 TYPESAFE_API_KEY=local
export JEV_BROWSER_CONFIG=/tmp/jev-run/config-<name>.json   # 重建：mkdir -p /tmp/jev-run，写一份只改 journalDir 与 chrome.userDataDir 的 config
# （当时的 /tmp/jev-local-smoke/ 已随 /tmp 清理删除，见文首说明）
node skills/jev-browser/bin/jev-browser.mjs run --goal "<goal>" --url <url> \
  --backend chrome --headless --max-steps <8|5|6> --json
```

`--max-steps` 全部取 4–8；`timeoutMs` 保持**默认 20000**（除 M 组 2 次刻意放大，见 §5 注）。
退出码：`success=0`、`needs_user=3`、其余 2（`bin/jev-browser.mjs:132-134`）。

---

## 2. 各次 run：目标、结局、步数、墙钟、停在哪

`steps` = controller 真正执行的动作数（`memory.history.length`）；`needs_user`/首步 `stop` 会是 0 步但已花掉 1 次 judge。

| # | goal（简写） | 站点 | 状态 | 退出码 | steps | 墙钟 | in-app | 停在哪 |
|---|---|---|---|---|---|---|---|---|
| R1 | 确认主标题是 "Example Domain" | example.com | **success** | 0 | 1 | 9.1 s | 5.9 s | step1 `goal_done=0.992` |
| R2 | 把 Red Gadget 加入购物车 | fixture /products | stuck | 2 | 1 | 10.1 s | 7.8 s | step2 模型选 `stop`（`goal_done=0.057`），实际只差一次点击 |
| R3 | DDG 搜 python → 打开 python.org | duckduckgo.com | stuck | 2 | 4 | 59.1 s | 56.1 s | step5 模型选 `stop`；全程**没机会输入**（§6.1） |
| R4 | 打开 Docs 并点按钮显示密码 | fixture / | stuck | 2 | 4 | 31.4 s | 26.6 s | step5 模型选 `stop`，**目标其实第 2 步就达成了** |
| R5 | 点 Accept 关掉 cookie 弹窗 | fixture /consent | stuck | 2 | 1 | 16.3 s | 12.6 s | step2 模型选 `stop`，**目标第 1 步已达成** |
| R6 | 从搜索结果打开 python.org | duckduckgo.com/?q=… | **needs_user** | 3 | 0 | 29.5 s | 26.1 s | step1 `blocker=verification_challenge(0.973)` —— **真阳性**（DDG 出人机验证，§4） |
| R7 | 打开 Alan Turing 条目 | en.wikipedia.org Special:Search | **success** | 0 | 4 | 46.4 s | 45.2 s | step4 `goal_done=0.995`（state 65 个元素 / 64 个可点选项里点对 `e20`） |
| R8 | 搜 Wikipedia → 打开条目 | en.wikipedia.org Main_Page | max_steps | 2 | 8 | 96.4 s | 94.8 s | 8 步用尽，末次校验 `goal_done=0.005` |
| p1 | 确认商品页已打开并显示价格 | fixture /products/red-gadget | **success** | 0 | 1 | 5.5 s | 4.5 s | step1 `goal_done=0.982` |
| p2 | 确认目录页已打开 | fixture /products | **success** | 0 | 1 | 4.4 s | 3.5 s | step1 `goal_done=0.988` |
| p3 | 给 Team 套餐开免费试用 | fixture /pricing | **needs_user** | 3 | 0 | 5.5 s | 4.7 s | step1 `blocker=missing_information(0.684)` —— **假阳性**，§4 |
| p4 | 用给的邮箱/密码登录 | fixture /login | stuck | 2 | 3 | 17.1 s | 16.2 s | 连续 3 次无变化动作；**全程没输入**（§5） |
| g1 | 把 Red Gadget 加入购物车（商品页起步） | fixture /products/red-gadget | stuck | 2 | 0 | 6.0 s | 6.0 s | step1 模型选 `stop(0.43)`，页面正中间就是 "Add to cart" |
| g3 | 点按钮显示密码并确认可见 | fixture /docs | stuck | 2 | 1 | 9.6 s | 9.6 s | step2 模型选 `stop`，**目标第 1 步已达成**（`goal_done=0.329`） |
| g4 | 填联系表单并发送 | fixture /contact | stuck | 2 | 0 | 8.3 s | 7.2 s | step1 模型选 `stop(0.30)`，四个字段的值都已提供 |

补充：
- R6 / p3 的 `steps=0` 但 journal 里有一条 step1 —— 判定发生在动作之前，`steps` 只数动作。
- R6、p3 的 `handOff` 均为 `null`；`resume` 里只有 `{backend,cdpUrl,targetId}`，没有 `spaceId`。CLI 仍会打印
  “the browser was handed to you; resume with --space-id …”（`bin/jev-browser.mjs:128`），而 chrome 后端在
  `success=false` 且 headless 时会关掉浏览器（`lib/backends/chrome.mjs:406`）—— 这条 `needs_user` 提示对 chrome 无意义（§6.4）。

### 2.1 逐 run 归因（journal `steps.jsonl` + `requests.jsonl`）

| run | 归因 | 依据 |
|---|---|---|
| R1 / p1 / p2 / R7 | **无问题**（正常终止） | R7 由 `goal_done=0.995` 收尾；其余 3 次首步 `goal_done≥0.982` |
| R2 / g1 | **模型误判（action）** | 商品页 `action=stop(0.43/0.32)`，而 `click_target` 的第一名就是页面正中的 `button 'Add to cart'`；元素不缺、也没报错 |
| g4 | **模型误判（action）** | 联系表单页，4 个字段的值都在 `inputs` 里，`editable` 4 个、`type` 在 `allowedActions` 内，`action` 仍选 `stop(0.30)` |
| R4 / R5 / g3 | **模型误判（goal_done 语义）** | 动作本身做对了（R4 第 2 步、R5 第 1 步、g3 第 1 步的目标均已达成，见 `finalTextExcerpt`），但 `goal_done` 只有 0.281/0.586/0.329（<`goalDoneFinal` 0.7）→ 记 `stuck` |
| p4 | **模型误判（action 排序）** | `action` 四选一里 `type` 垫底（0.105），虽然 `type_target`=Email(0.851)、`type_value`=email(0.933) 都对；controller 按模型序执行 ⇒ 3 次无变化 |
| R8 | **模型误判 + controller 放大** | `type` 已提供（100 元素/99 可点/1 可编辑，`allowedActions` 含 `type`）却没被选；controller 的 progress 规则又两次选了走不通的 `go_back`（`no previous page in history`） |
| R3 | **证据缺口（missing evidence）** | `<input role="combobox">` 在观测里不是 `editable`（§6.1，dry-run 实测 `editable=0`），`type`/`type_target`/`type_value` 三问根本没生成 ⇒ 模型只能在 click/scroll/wait/stop 里挑 |
| p3 | **模型误判（blocker 假阳性）** | 定价页给出 `missing_information(0.684)`；页面三个套餐与按钮都列在元素表里，`inputs` 也不缺 |
| R6 | **真阳性，但 run 无事可做** | DDG 返回人机验证（`visible_text` 逐字可查），`verification_challenge(0.973)` 判对了；这次没有可自动化空间 |
| — | **API 失败：0 次** | 39/39 请求 `status=succeeded`、`attempts=1`；无 `TIMEOUT`/`LOW_LABEL_MASS`/`CONNECTION` |
| — | **后端/driver 异常：0 次** | 无 `error` 状态、无 Chrome 启动失败；唯一反复出现的 `no previous page in history` 是 controller 主动 `go_back` 后被 driver 正确拒绝（§6.3） |

---

## 3. 逐步延迟画像（39 个步骤请求，全部取自 `requests.jsonl`）

单步 = 一次 HTTP 批次调用里本地 provider 顺序跑完该步的所有问题；`prompt_tokens` 是**未命中前缀缓存、真正需要重算**的 token（`timings.prompt_n`）。

| 指标 | p50 | mean | max |
|---|---|---|---|
| 单步请求（客户端观测） | **4,312 ms** | 5,984 ms | **18,151 ms** |
| 本地服务 `ms_total` | 4,310 ms | 5,978 ms | 18,147 ms |
| 单步 prompt tokens（去缓存后） | 3,555 | 4,680 | 12,254 |
| 单步问题数 | 5 | 5.6 | 8 |

按问题拆（同一批内，第一问承担 state 预填充，其余问题命中 llama.cpp 前缀缓存）：

| 问题 | n | p50 | mean | max | prompt p50 | cold/warm | label_mass p50 / min |
|---|---|---|---|---|---|---|---|
| `goal_done` | 39 | **1,165 ms** | 2,317 ms | 8,887 ms | 933 | 29/10 | 0.966 / 0.939 |
| `blocker` | 38 | 725 ms | 737 ms | 953 ms | 559 | 1/37 | 0.995 / 0.990 |
| `click_target` | 38 | 713 ms | 1,373 ms | 4,499 ms | 490 | 0/38 | 0.992 / 0.926 |
| `progress` | 23 | 606 ms | 587 ms | 771 ms | 442 | 0/23 | 0.995 / 0.984 |
| `action` | 38 | 595 ms | 606 ms | 798 ms | 464 | 0/38 | 0.985 / 0.870 |
| `select_target` | 7 | 568 ms | 547 ms | 721 ms | 362 | 0/7 | 0.962 / 0.932 |
| `submit_after_type` | 12 | 567 ms | 596 ms | 807 ms | 465 | 0/12 | 0.990 / 0.977 |
| `type_target` | 12 | 547 ms | 596 ms | 1,013 ms | 433 | 0/12 | 0.983 / 0.971 |
| `type_value` | 12 | 546 ms | 553 ms | 748 ms | 418 | 0/12 | 0.977 / 0.968 |

结论与既有文献的两点修正：

1. **`click_target` 不再是最贵的**。`experiments/gguf-provider/RESULTS.md` 里 “click_target 6.1 s、整步 9 s（热）/18.3 s（冷）”
   是在**不命中前缀缓存**的口径下量的；真实 run 里 provider 顺序发问，state 只算一次（`goal_done` 那一问承担，
   p50 1.2 s、max 8.9 s），后面每一问只付「问题块」的增量（400–500 tok，0.5–0.7 s）。整步 p50 落在 **4.3 s**。
2. **但默认 20 s 客户端超时是真的紧**。R8 step8 的状态是 12,254 tok，单步 **18,151 ms**，距 `timeoutMs=20_000`
   只剩 **1.85 s**；`lib/typesafe.mjs:201-207` 的超时标 `retryable`，一旦触发会把整批 5–8 问重跑（最多 3 次），
   本次 15 次 run 没有触发，但更大页面/更慢机型会踩。39 步里 0 次超时、0 次 `LOW_LABEL_MASS`。

---

## 4. `goal_done` 分离分析：有没有一条阈值能分开「已达成 / 未达成」

数据两部分：(a) **首步校准探针 16 项**——用 skill 自己的 `run --dry-run` 构造第一步 state（含 goal/inputs/page），
只把 `goal_done` 这一问发给本地服务，真值由页面构造决定；(b) **15 次 run 的 39 个步骤判定**，真值由 journal + 最终页面人工判定。

### 4.1 首步校准（16 项，state 与 controller 实际发送的完全一致）

| id | 真值 | goal_done | id | 真值 | goal_done |
|---|---|---|---|---|---|
| T1 商品页已打开 | 达成 | **0.981** | F1 加入购物车 | 未达成 | 0.008 |
| T2 目录页已打开 | 达成 | **0.988** | F2 登录成功并看 dashboard | 未达成 | 0.007 |
| T3 联系表单在页面上 | 达成 | **0.954** | F3 Team 试用已开始 | 未达成 | 0.008 |
| T4 登录页在问邮箱密码 | 达成 | **0.969** | F4 已显示密码 | 未达成 | 0.032 |
| T5 三个套餐已列出 | 达成 | **0.987** | F5 弹窗已关闭 | 未达成 | 0.096 |
| T6 页面说需要管理员权限 | 达成 | **0.936** | F6 已打开定价页且 $29 | 未达成 | 0.011 |
| T7 页面在问 cookie 同意 | 达成 | **0.839** | F7 已打开 Docs | 未达成 | 0.043 |
| T8 主标题 Example Domain | 达成 | **0.997** | F8 已从链接打开 IANA | 未达成 | 0.036 |

**达成 0.839–0.997（n=8）；未达成 0.007–0.096（n=8）。最大负例 0.096 ≪ 最小正例 0.839，中间是一段空档。**
即「这页是不是已经是目标状态」这一问，本地 4B 是可用的；官方阈值 0.85 只有 1/8 真例踩线落空（T7 = 0.839），
0/8 假阳性。任何落在 **[0.10, 0.83]** 的阈值都能把这 16 项全部分开。

### 4.2 run 内的判定（含「做了一步之后」的状态）——分离失效

| 类别 | 样本（goal_done） |
|---|---|
| 未达成，首步 | R2 .008 · R3 .004/.011/.012/.006/.006 · R4 .010 · R5 .096 · R6 .005 · p3 .008 · p4 .010 · R7 .023/.015/.014 · R8 .003/.022/.015/.009/.009/.008/.010/.011（+末次 .005）· g1 .050 · g3 .027 · g4 .012 |
| 未达成，但**做了一步**（最危险的一档） | **R4 step2 = 0.111** |
| 已达成，且是首步就能判 | R1 .992 · p1 .982 · p2 .988 |
| 已达成，**靠动作达成** | R7 step4 **.995** · R5 step2 **.586** · g3 step2 **.329** · R4 step3 **.273** · R4 step5 **.281** · **R4 step4 = 0.058** |

- 未达成侧最大 **0.111**（R4 step2，点了按钮但页面刚变）；已达成侧最小 **0.058**（R4 step4，同一页、密码已可见）。
  **两个区间重叠 ⇒ 不存在能把「已达成 / 未达成」分开的阈值。**
- 这不是「阈值调低一点就行」：把阈值放到 0.2 能救回 g3(0.329)/R4(0.273)，但会救不回 R4 step4(0.058)，而
  同一页 step2 的 0.111 又高于它 —— 判定顺序本身不稳定（同页同目标：0.111 → 0.273 → 0.058 → 0.281）。
- 反过来说，`goal_done` 在「页面本身就是答案」的场景（R1/R7/p1/p2、T1–T8）非常干净，0.98 上下；
  **它坏掉的正是「做完一个动作之后」这一类**——4B 对「动作产生了结果」的确认能力不足。

### 4.3 对控制器的直接后果

- `goal_done >= 0.85`（`lib/config.mjs:27`）在动作型目标上**永远不会触发**：本次 6 个「已达成」样本里 5 个 < 0.85。
- 于是 run 只能靠 `stop` 分支收尾，而 `stop` 只有在 `goal_done >= goalDoneFinal(0.7)`（`lib/config.mjs:28`）时才记 `success`：
  R4(0.281)、R5(0.586)、g3(0.329) 三个**实际已经完成**的 run 被判 `stuck`，退出码 2。
- 末次校验（`maxSteps` 用尽后补问一次）用的正是同一个 0.7：R8 得 0.005，判 `max_steps`（这次判对了）。
- **所以「本地后端能不能跑完」与「本地后端能不能承认自己跑完」是两件事**：前者可以（R7），后者不可信。

---

## 5. `action` 选择：与页面明显允许的动作不符

按严重度排序（全部有 journal 逐字证据）：

1. **p4（登录页）——模型知道该填哪儿、填什么，就是不选「type」。** 同一 state 的完整判读（当时用 `/tmp/jev-local-smoke/login.dryrun.json` 重放，该文件已随 `/tmp` 清理删除；数字是现场记录，按 §7.3 的 `--dry-run` 流程重放同一登录页可复现）：
   ```
   action         click 0.430 · stop 0.246 · wait 0.220 · type 0.105     ← 四选一里 type 垫底
   type_target    e2 (Email)  0.851   ← 正确
   type_value     email       0.933   ← 正确
   click_target   e4 ("Sign in" 按钮) 0.892
   submit_after_type  0.183（= "不按回车"，也对）
   ```
   controller 按模型动作序建候选（`lib/controller.mjs:263` 的 `for (const [action] of decision.actions)` → `:320-323` 的取候选），于是先挑 `click e4`（空表单，无变化），
   再挑 `wait`（无变化），第三个才轮到 `type` —— 3 次无变化后 stuck（`noChangeLimit=3`）。
2. **R3（DDG 首页）/ R8（Wikipedia 主页）——同样从不输入**：R3 依次点了搜索框 combobox、Search 单选、"
   Set As Default Search" 链接；R8 点了 Search 按钮、搜索框 combobox、滚屏、返回，最后点进一篇无关条目
   （Hashim Thaçi）。两者原因不同：R3 的 `type` 是**结构上就没被提供**（§6.1）；R8 的 `type` 提供了
   （Main_Page dry-run：100 个元素 / 99 个可点 / 1 个可编辑，`allowedActions=click,type,scroll_down,wait,stop`，
   `type_target`/`type_value`/`submit_after_type` 三问齐全，`inputKeys=[query]`）却没被选。
3. **提前 `stop`（3 次）**：g1/g4 在「页面正中就是 Add to cart / 四个字段都已给值」时第一问就选 `stop`
   （0.43 / 0.30）；R2 在商品页选 `stop`（0.32）。`action` 的 confidence 只有 0.06–0.13（无信心），
   但 controller 不用 confidence 做弃权（`lib/typesafe.mjs:57` 归一化后只给 `confidence` 字段，无人消费）。
4. **R7 的 `go_back` 空转**：第 1–2 步 `action` 把 `go_back`(0.28) 排在 `click`(e20 = 正确的 Alan Turing 链接) 前面，
   白走两步（`go_back` 的 `click_target` 一直是 e20 —— 选元素没问题，选动作有问题）。
   第 2 步 `go_back` 失败（`no previous page in history`）。
5. **R8 的重复无效 `go_back`**：step5/7/8 由 controller 的「progress 退化」规则（`lib/controller.mjs:257-261`）
   自己选了 `go_back`，其中两次报 `no previous page in history`；因为 blocked 记忆的键是
   `${stateHash}|${actionKey}` 而 state 每步都变（含 `previous_page`/`last_action`，`lib/controller.mjs:193-196`），
   同一台不可能完成的动作被反复重试。

对照：**`click_target` 是本次最稳的一环**。R7 在 65 个元素的真实页面上，每一步都把正确条目排在第一
（`e20 = link 'Alan Turing' → /wiki/Alan_Turing`，0.784 / 0.742 / 0.713；第二名 `e22` 是同一个 `/wiki/Alan_Turing` 的另一处链接，
0.17 / 0.22 / 0.25，两者合计 0.95 —— 即使第一名失手，结果页也是对的）；R2 step1、R4 step1/2、R5 step1、g3 step1 在 fixture 上也都点对。
RESULTS.md 里 “`action + click_target` 5 题只对 2 题” 的短板，在真机 run 里重现的是其中的 **action 半边**。

---

## 6. 观测/代码层问题（只报告，未改任何 `skills/**` 文件）

> **状态更新 2026-09-24 ~01:25（本次 run 之后，工作区并发改动、未提交）**：6.1（combobox 不是 textbox）、
> 6.4（`needs_user` 的 ego 专属提示）、6.5（本地 token 按 hosted 价格计费）三条**已在 `skills/**` 里被修**：
> `lib/observe.mjs` 新增 `isComboboxField()` + `tests/e2e/combobox.test.mjs`；`bin/jev-browser.mjs` 的 `needs_user`
> 分支改为有 `spaceId` 才提示 `--space-id`，否则说明浏览器已关闭；`lib/typesafe.mjs` 新增
> `isLoopbackBaseUrl()`/`pricePerMtokFor()`，loopback 计费为 0。6.2/6.3/6.6 未被改动。下面保留的是
> **实测时的行为**（run 时间 00:54–01:08），行号按当时的工作区版本。

### 6.1 `role="combobox"` 的 `<input>` 被当成非文本字段 → 永远没有 `type` 动作

> **状态更新 2026-09-24 ~01:25**：本条已被并发修复（工作区未提交）—— `lib/observe.mjs` 新增 `isComboboxField()`，
> 把 `role=combobox` 的 `<input>/<textarea>/[contenteditable]` 归为 `textbox`，并加了 `tests/e2e/combobox.test.mjs`。
> 下面描述的是**本次全部 run 所测的修复前行为**（run 时间 00:54–01:08），保留作为 §5 中 R3 的成因记录。

`lib/observe.mjs:40`：只要元素带 `role` 属性就原样采用（`if (role) return role.toLowerCase();`），
`lib/observe.mjs:134` 只有 `role === "textbox"` 才置 `editable`；`lib/questions.mjs:88` 又要求
`editable.length && inputKeys.length` 才把 `type` 放进 `allowedActions`。

DDG 首页/结果页的搜索框是 `<input role="combobox">`（ARIA 1.2 组合框写法）→ 观测里是
`combobox 'Search with DuckDuckGo'`、`editable` 计数 **0**，`action` 选项只剩 `click,scroll_down,wait,stop`，
`type_target/type_value/submit_after_type` 三问根本不生成。**R3「不会输入」不是模型的错，是证据缺口。**
对照：Wikipedia 的搜索框把 `role=combobox` 放在**外层容器**上，`<input>` 自身是 `textbox` → 观测正常
（`text field 'Search Wikipedia' (type search, …)`），fixture 的 `<input id="q">` 同样正常。
这里**不需要看本地模型**：hosted Jev 在 DDG 这样的站点上也会失去 `type` 选项。

### 6.2 候选动作顺序 = 模型动作序，`type` 排后面就永远到不了

`lib/controller.mjs:264-323`：候选完全按 `decision.actions`（模型概率序）展开，`open.find(c => !tried.has(...))`
取第一个没试过的非 `stop` 候选。p4 里 `click → wait → type`，于是在 `click`/`wait` 都试废之前，正确的 `type`
不会被尝试（3 次无变化直接 stuck）。`type` 没有任何「信息增益优先」的加成，也没有用 `actionConfidence` 做弃权。

### 6.3 失败动作不会被记住

`lib/controller.mjs:193-196` 的 `blocked` 键含 `stateHash`，而 state 每步都变（`previous_page`、
`last_action` 参与），所以「driver 明确报错」（如 `no previous page in history`）的动作会在下一步换个 hash 后重来。
R8 里连续两次白跑。真正需要的是「动作种类级」的失败记忆，而不是 (状态 × 动作) 级。

### 6.4 `needs_user` 在 chrome 后端不可执行

R6/p3：`handOff: null`、`resume` 无 `spaceId`，且 headless 下浏览器已被关掉（`lib/backends/chrome.mjs:406`
`keepPage = keep ?? (success && chrome.keepOnSuccess !== false && !headless)`），而 CLI 提示语仍是 ego 专属的
“the browser was handed to you; resume with --space-id …”（`bin/jev-browser.mjs:128`）。这次 R6 是**真**拦住
（人机验证），用户按提示去接管时会发现没有浏览器可接。

### 6.5 本地 run 的 `costUsd` 是假的

`lib/runner.mjs:61` 把 `config.pricePerMtok`（默认 0.042 美元/Mtok）传给客户端，`lib/typesafe.mjs:150` 照此
对本地 token 记账：R8 报 `costUsd=0.002705`。本地 token 实际 $0。只影响显示与 `budgetUsd` 预算判断（本次最贵的
R8 也只有 0.0027 ≪ 0.25，没触发）。

### 6.6 `steps` 与 `usage.requests` 不是一回事

`needs_user`/首步 `stop` 的 run 报 `steps: 0` 但已消耗 1 次请求（R6、p3、g1、g4）；`max_steps` 的 run 最后一次
校验请求不在 `steps` 里（R8：8 步 / 9 请求）。读 journal 时不要拿 `steps` 当「问过几次」。

---

## 7. 复现

```bash
# 1) 起本地后端（8090/8092）与 fixture（3111）
node skills/jev-browser/bin/jev-local.mjs         # 前台；Ctrl-C 只停它自己起的 llama-server
node --input-type=module -e "const {createSite}=await import('./tests/fixtures/server.mjs');const s=createSite();await new Promise(r=>s.server.listen(3111,'127.0.0.1',r));"

# 2) 一条「能跑完」的最小样例（本例 4 步 success）
export TYPESAFE_BASE_URL=http://127.0.0.1:8092 TYPESAFE_API_KEY=local
node skills/jev-browser/bin/jev-browser.mjs run \
  --goal "Open the Wikipedia article about Alan Turing." \
  --url "https://en.wikipedia.org/wiki/Special:Search?search=Alan+Turing&fulltext=1" \
  --backend chrome --headless --max-steps 8 --json

# 3) 首步校准探针（16 项）：用 skill 自己的 --dry-run 构造 state，只把 goal_done 一问发给本地服务
#    （—dry-run 输出首行为人类摘要，JSON 从第一个 { 开始）
node skills/jev-browser/bin/jev-browser.mjs run --dry-run --goal "Confirm the sign-in page is open and asks for an email and a password." \
  --url http://127.0.0.1:3111/login --backend chrome --headless 2>/dev/null | tail -n +2 > /tmp/dry.json
node -e '
const d=JSON.parse(require("fs").readFileSync("/tmp/dry.json","utf8"));
fetch("http://127.0.0.1:8092/v1/systemone",{method:"POST",headers:{authorization:"Bearer local","content-type":"application/json"},
  body:JSON.stringify({model:"local",state:d.state,questions:{goal_done:d.questions.goal_done}})})
  .then(r=>r.json()).then(j=>console.log(j.answers.goal_done));'   # → noul≈0.969

# 4) 汇总脚本：probe.mjs / latency.mjs / analyze.mjs 当时在 /tmp/jev-local-smoke/，
#    从未入库，且已随 /tmp 清理删除，无法恢复。它们只是把 journal 聚合成 §3/§4 的表，
#    重跑这轮实测 = 用上面 1)–3) 的命令重建（起 jev-local + fixture，再跑 jev-browser run），
#    产物 journal 落在配置的 journalDir 下，自行汇总即可。
```

注：DDG 在本机 + headless 下会返回**人机验证**（“Unfortunately, bots use DuckDuckGo too. … Select all squares
containing a duck: Submit”，见 `r6.dryrun.json` 的 `visible_text`），所以「搜索结果页 55 选项」这一族没能用 DDG 测，
改用 Wikipedia 搜索结果页（65 个元素 / 64 个可点选项，`wiki.dryrun.json`）。R6 的 `needs_user` 因此是**真阳性**。

---

## 8. 判定：本地后端哪些用法安全、哪些不安全

**安全（有数据支撑）**
1. `jev-browser judge` / `pick` 单问或多问一批 —— 39 步 0 失败、0 低 label_mass，整步 p50 4.3 s、$0。
2. **「当前页面是不是已经是目标状态」** 这一问：首步 8/8 真例 ≥0.839、8/8 负例 ≤0.096，阈值 0.85 只有 1 次踩线。
   适合做「打开某页 → 确认到达」这类只读型目标（R1/p1/p2 都是 1 步 success）。
3. **`click_target` 选元素**：64 个可点选项的真实页面上每一步都选对；小 fixture 上同样对。

**不安全（有数据支撑）**
1. **`goal_done` 的阈值 0.85 在本地偏高**（细节与计分见 §9）：按「第一次越线即 success」的终止语义，
   **0.25（可用带 0.12–0.28）得到 7/7 正确 success、0 假 success、0 假 stuck**；0.85 得到 4/7，假 stuck 3 次
   （R4/R5/g3，均已实际完成）。**不要**用代码侧规则替代它（实体匹配、环检测各产生 4 次假 success，聚合无增益）。
   注意：逐「步」分类确实不可分（§4.2），能分的是「一条 run 里第一次越线的那一步」。
2. **`action` 动作选择**：四选一里正确的 `type` 被排到末位（0.105 vs click 0.430），3 次 run 全程未能输入；
   另有 3 次在「明显该点/该填」的页面上第一问就选 `stop`。要跑通表单/搜索类任务，必须在 controller 侧加
   信息增益优先或 confidence 弃权，而不是指望调 prompt。
3. **`blocker` 在「有内容可操作」的页面上**：p3 在 fixture 定价页给出 `missing_information(0.684)` → 假 `needs_user`；
   另有 2 次擦边（R4 step2 `missing_information` 0.368、R5 step1 `consent_or_permission_dialog` 0.393，都是 0.6 阈值下的
   第二名）。真阳性只有 1 次（DDG 人机验证 0.973）。即：**`needs_user` 的中断结论在本地不可当回事**。
4. 传输层边界：单步 18.2 s（12.2k tok）对默认 20 s 超时只剩 1.85 s，更大页面会触发可重试超时并把整批重跑最多 3 次。

---

## 9. 终止规则回放：哪条规则能让本地 `run` 正确地报 `success`

离线回放，无新浏览器 run；模型调用只用已保存的 state（§9.4）。回放脚本是 `/tmp/jev-local-smoke/rules.mjs`（纯离线，只读 `steps.jsonl`）——**该脚本与它读的 journal 都在 `/tmp/jev-local-smoke/`，已随 `/tmp` 清理删除、从未入库**；§9 的计分表是当时的现场记录，按 §9.1 的口径对一份 journal 重算即可复现。

### 9.1 计分口径（严格）

- journal 第 N 行的页面是第 N 步动作**之前**看到的页面；真值逐 (run, step) 标注：39 步里 **9 步是达成页**
  （R1 s1、R4 s3/s4/s5、R5 s2、R7 s4、p1 s1、p2 s1、g3 s2）。
- **正确 success**：规则触发的那一步，页面本身已经满足目标。
- **假 success**：在未达成的页面上触发 —— 因为 run 会在动作之前停下，目标永远不会被达成。**一次即否决该规则。**
- **漏报 success（= 假 stuck）**：该 run 出现过达成页，但规则从未触发。
- **正确 stuck**：该 run 从未出现达成页，规则也从未触发。

### 9.2 结果（`!` = 触发在未达成页上；`-` = 未触发）

| 规则 | 阈值 | 正确 success | 假 success | 假 stuck | 正确 stuck | 各 run（触发步） |
|---|---|---|---|---|---|---|
| 1 `goal_done`（现行） | 0.85 | **4** | 0 | **3** | 8 | R1:1 R2:- R3:- R4:- R5:- R6:- p1:1 p2:1 p3:- p4:- R7:4 R8:- g1:- g3:- g4:- |
| 1 `goal_done` | 0.70 | 4 | 0 | 3 | 8 | 同上 |
| **1 `goal_done`** | **0.25** | **7** | **0** | **0** | **8** | R1:1 R2:- R3:- **R4:3** R5:2 R6:- p1:1 p2:1 p3:- p4:- R7:4 R8:- g1:- **g3:2** g4:- |
| 1 `goal_done` | 0.15 | 7 | 0 | 0 | 8 | 同上（R4:3 R5:2 g3:2 都在达成页触发） |
| 1 `goal_done` | 0.10 | 6 | **1** | 0 | 8 | … **R4:2!** …（docs 页刚点开、密码还没显示，读数 0.111） |
| 1 `goal_done` 可用带 | **0.12 … 0.28** | 7 | 0 | 0 | 8 | — |
| 3a-i 实体出现在 url+title | — | 2 | **4** | 3 | 6 | R1:1 R2:2! R4:2! p1:1 R7:1! g1:1! |
| 3a-ii 实体出现在 path+title | — | 2 | **4** | 3 | 6 | 同上 |
| 3a-iii 实体只出现在 path | — | 2 | **3** | 4 | 6 | R2:2! R4:2! p1:1 g1:1! R7:4 |
| 3b-i 模型选 stop 且上一步无变化 | — | 0 | 0 | 7 | 8 | 从不触发 |
| 3b-ii 环检测（url+title+元素数重复） | — | 2 | **4** | 4 | 5 | R3:3! p4:2! R7:3! R8:3! R4:3 g3:2 |
| 4 全局 max | 0.85 | 4 | 0 | 3 | 8 | 同基线 |
| 4 全局 max | 0.25 | 7 | 0 | 0 | 8 | 同阈值 0.25 |
| 4 max of last 3 | 0.25 | 7 | 0 | 0 | 8 | 同阈值 0.25 |
| 4 median of last 3 | 0.15 | 6 | 0 | **1** | 8 | R7:-（.995 被中位数抹掉） |
| 4 median of last 3 可用带 | — | — | — | — | — | **无** |
| 阈值 ≥t **且** 实体命中 | 0.25 | 6 | 0 | **1** | 8 | g3:-（实体 "secret code" 不进 url/title） |
| 阈值 ≥t **或** 实体命中 | 0.25 | 5 | **4** | 0 | 6 | R2:2! R4:2! R7:1! g1:1! |
| 阈值 ≥t **且** 上一步页面有变化 | 0.25 | 7 | 0 | 0 | 8 | 同阈值 0.25（本数据集上是空操作） |

### 9.3 赢家：把阈值从 `0.85` 降到 **0.25**（可用带 0.12–0.28），规则本身不用动

- **7/7 正确 success、0 假 success**；对照现行 0.85 的 4/7 正确 + 3 个假 stuck（R4/R5/g3）。
- 触发点全部落在达成页上：R1 s1(0.992)、R4 s3(0.273)、R5 s2(0.586)、R7 s4(0.995)、p1 s1(0.982)、p2 s1(0.988)、g3 s2(0.329)。
- 8 个从未达成的 run 一次都没触发 → 8 个正确 stuck。
- 两个边界：可用带下沿 **0.12** 距最高的未达成读数 **0.111**（R4 s2）只有 1.08×；8 个未达成 run 内部的最高读数是
  **0.057**（R2 s2），距 0.25 有 4.4×。所以下沿受「动作前的那一步」约束，不是受未达成 run 约束。
- 聚合没有帮助：全局 max / max-of-last-3 与单次读数同分（只是把可用带整体平移，低阈值下同样会早触发）；
  **median-of-last-3 反而把 R7 的 0.995 尖峰抹平 → 漏报 1 次**，并且没有可用带。
- 代码侧规则不能替代判据：**实体匹配 4 次假 success**（R2:2、R4:2、R7:1、g1:1 —— 其中 R2/g1 是整个 run 从未达成，
  最坏的一类：搜索结果页 URL/title 里回显查询词、商品页 URL 里就有商品名）；**环检测 4 次假 success**，
  并且若把它当 stuck 用会掐掉 R7（正是那个能成功的 run）。
- 与代码侧组合：`阈值≥t AND 上一步有变化` 与纯阈值同分（空操作）；`AND 实体` 会漏掉 g3；`OR 实体` 立刻产生 4 次假 success。

### 9.4 规则 2（去掉 volatile conditioning）：前提不成立，**不要为此改代码**

journals 不保存 state 对象（只有 url/title/elementCount/targets/各问答案），所以「把 `last_action`/`previous_page`
从真实步骤里删掉再问」无法离线回放。可做的是两侧合围，结论一致：

- **同页同目标、条件不同的真实读数**（journal 内的同页分组）：
  - R4 `/docs` 四步 **0.111 / 0.273 / 0.058 / 0.281 → spread 0.223**（页面内容相同；密码在第 2 步之后一直是可见的）；
  - p4 `/login` 三步 0.010 / 0.035 / 0.011 → spread 0.025；R8 Main_Page 四步 spread 0.008；R3 DDG 首页 spread 0.006。
- **固定页面 + 合成 conditioning**（6 个已保存 state × 5 种条件 =「无 conditioning + 4 种 `last_action`」，30 次判读）：
  spread 最大 **0.057**（contact 页 0.012→0.066），最小 0.004；换一个**不同页面**当 `previous_page`
  （6 次判读）swing ≤ 0.033。即 volatile 块本身最多移动 ~0.06。
- **真实 post-action 配置重放**（页面不变，conditioning 用 journal 里那一步的真实 `last_action` + `previous_page`）：
  p4 s2 journal 0.035 = 重建 0.035（重建保真）/ 去 conditioning 0.010；p4 s3 0.011 / 0.009 / 0.010；
  R3 s2 0.011 / 0.012 / 0.004；R3 s4 0.006 / 0.008 / 0.004；R7 s2 0.015 / 0.014 / **0.029**；R7 s3 0.014 / 0.016 / **0.029**。
  → 去 conditioning 在 6 个可重放的 post-action 配置上把读数移动最多 **0.025**（p4 s2：0.035→0.010；其余 ≤0.015），全部仍远低于任何阈值；**不会新增假 success**。
- 结论：**R4 那个 0.223 的同页波动不是 conditioning 造成的**（conditioning 只能解释 ≤0.06），而是「动作之后这一页本身」
  被判低 —— 这与 §4 的判断一致。去掉 conditioning 既不修 R4/R5/g3，也不引入假 success，属于**空操作**，
  不要为它改 `controller.mjs`。要真正验证 met 侧的这条假设，必须先让 journal 存下 state。
- 保真度校验：把已保存 state 去掉 conditioning 后重放，读数与 journal 首步几乎逐位一致
  （R3 .004/.004、R6 .005/.005、R7 .029/.023、R8 .003/.003、p4 .010/.010）→ 该实验的测量本身可信。
- 模型用量：本次全部判读 **~60 s** 推理（共 67 次 goal_done：校验 5 + 真实 post-action 14 + 合成 conditioning 30 + 换 previous_page 18），远低于 20 min 预算。

### 9.5 覆盖与掉队声明

- 15 个 run、39 步全部进入回放，**没有丢弃任何 run**。
- 3a 的实体是人工从 goal 里挑的（真实实现需要抽词器）；R5/p2/g4 这类 goal 没有实体 → 该规则在它们身上只能不触发，
  这已经计入表里的「假 stuck」。
- 9.4 里 **R8 s2 一行作废**：那一步的页面是 `/w/index.php?search=&title=Special%3ASearch`，与已保存的 Main_Page state 不是同一页
  （journal 的分组把两者混在一起），该行已从结论中剔除。
- 9.4 无法覆盖的：**任何「达成页 × 动作之后」的 state**（R4 s3/s4/s5、R5 s2、g3 s2 的页面都没有被保存）——
  这正是规则 2 唯一需要的那一格。

### 9.6 SKILL.md 该改成什么

`skills/jev-browser/SKILL.md` 现在的句子（第 166–176 行）：

> …but the `goal_done >= 0.85` rule that prints `success` cannot be trusted for a goal that needs an action:
> … so the two bands overlap and **no threshold separates them**. `0.85` therefore never fires for an action goal,
> runs that had actually finished were reported `stuck` … unless the termination rule stops relying on `goal_done`
> (a rule over the final URL and title would do).

建议替换为（事实依据：§9.2/§9.3）：

> …but the value `0.85` is wrong for this backend, not the question. Scored as a termination rule (first step whose
> reading crosses the line), `goal_done >= 0.25` — any value in 0.12–0.28 — called **every one of the 7 runs that did
> reach the goal** a success **at a page that already showed the goal**, and never fired on the 8 runs that never got
> there: 7 correct successes, 0 false successes, 0 false `stuck` (the shipped 0.85 gave 4 / 0 / 3). Do not replace
> `goal_done` with a code-side rule: "the goal's named entity appears in the final URL or title" false-fired on 4 runs
> (2 of them never completed — search URLs echo the query, product URLs contain the product name), loop detection
> false-fired on 4, and aggregating the last readings (max/median of 3) never beat the single reading — the median
> even lost the one run whose success was a single 0.995 reading. The volatile `last_action`/`previous_page` in the
> state are *not* the problem (measured effect <= 0.06): do not add code to strip them. Locally, use 0.25 on both the
> per-step check and the final check; `0.85` remains right for hosted Jev.

（`config set thresholds.goalDone 0.25` / `thresholds.goalDoneFinal 0.25` 就是实现；本文件不改 `skills/**`。）

> **2026-09-24 更新：已实现，且比这一节更细。** 落地的是同一带内的 **0.174**（可用带 0.12–0.28 的
> maximin 中点，`skills/jev-browser/lib/config.mjs` 的 `local-readout` profile），并且阈值现在按后端解析
> （`thresholds.profile`：hosted 0.85/0.70、GGUF readout 0.174、Kev **0.482**）—— 0.174 只对它被测量的
> readout 有效，Kev 的带是 0.341–0.683（`experiments/kev-4b/README.md`）。所以「`config set thresholds.goalDone 0.25`
> 就是实现」这句只作历史记录；不要再按它手工设值。

### 9.7 样本量警告

7 个可成功 run / 8 个永不成功 run / 39 步，全部来自**一台机器、一个 4B 量化模型、fixture + Wikipedia + DuckDuckGo**。
可用带 0.12–0.28 的下沿只比观测到的最坏未达成读数（0.111）高 1.08×，而这个 0.111 出现在一个**最终成功**的 run 内部；
未达成 run 内部的最高读数是 0.057。真实站点的分布一定更宽 —— 上表是「本地 4B 的可达性证据」，不是普适阈值证明。

# ComfyUI Windows 实机验收报告

日期：2026-11-02（Windows 本地时间 UTC+8）
依据：[Windows 实机测试需求](../../comfyui-windows-test.md)，共 31 条编号测试。
承办：Claude Code · 当前运行模型标识 `mythos-magpie-5878256367`。

## 结论

**不能判定完整验收通过。** 主机生成、分块放大、真实画笔局部重绘、本机排队与定向取消已有真实 GPU 证据。发现输入类型识别问题；用户提供的 FLUX＋LoRA 工作流运行时 ComfyUI 退出。成员网关测试因自动审批阻断未执行。

按下表主结果统计：16 项通过、2 项不通过、13 项未测。标为“未测”的条目中，有些已做本机或小模型替代验证，但不抵扣原条件。通过项的替代操作和局限均写在表中。

验收期间产品代码未改；本次仅提交报告与相关证据；正式 Atelier 5174 和正式 data root 未修改。没有调用计费模型，也没有删除、改名真实模型文件。测试创建的参考图和输出仍保留在 ComfyUI input/output 与隔离 data root。

## 环境与证据目录

| 项 | 实际值 |
|---|---|
| Atelier | `07405b23`，main；界面版本 5.133.0 |
| 系统 | Windows 11 Pro 10.0.26200 |
| ComfyUI | 源码安装，0.42.0；Python 3.11.6；PyTorch 2.7.0+cu128 |
| 安装目录 | `H:\n8n_output\ComfyUI\ComfyUI` |
| 启动方式 | `.ext\python.exe -s main.py --disable-auto-launch` |
| GPU | NVIDIA GeForce RTX 5080，约 16GB；API 总显存 17094475776 bytes |
| ComfyUI 地址 | `http://127.0.0.1:8188` |
| 正式 Atelier | 原有 5174，未停止、未改配置 |
| 测试主机 / 成员 | 本机 5175 / 5176，分别使用本地验收目录的 `host/`、`member/`（数据目录未上传） |
| 浏览器 | 真实 Edge，Playwright 驱动，独立 context 隔离 cookie |
| 系统代理 | 原本已开，127.0.0.1:7897；未改代理设置 |
| 第二台电脑 | 无；成员实例虽启动，网关未开启 |

文档约定的 `C:\atelier-test` 不存在且目录授权未成功解析，改用仓库内忽略目录 `.scratch/windows-acceptance/` 保存所有证据。文件时间中的 job ID 使用 UTC，日志/界面显示本地时间。

最终检查见 [final-state.json](final-state.json)：18 个任务、非零费用 0 个、未完成 0 个、ComfyUI running/pending 均空。费用检查的是 `params.estimated_cost_cny` 和 `params.actual_cost_cny`，不是不存在的顶层 `cost`。

## 工作流

| 来源 / 文件 | 用途与暴露输入 | 限制 |
|---|---|---|
| 用户 `<Downloads>\2026.11.02 Test.json`；原样副本 [original-api.json](fixtures/original-api.json) | FLUX.Krea.FP8_fast＋Xiongdawei_V3 LoRA；测试副本加 `in:`：提示词、LoRA强度、种子、输出宽度 | 原文件未改。原配置 768×1024、30 steps；实际运行失败 |
| [lora-tagged.json](fixtures/lora-tagged.json) | 上述工作流加标签的测试副本 | 为继续执行，在隔离配置中将 LoRA 强度改为 float、CR Text 改为 prompt；这不算自动识别通过 |
| [supplemental-inpaint-api.json](fixtures/supplemental-inpaint-api.json) | DreamShaper 8 SD1.5；提示词、原图、遮罩、种子；VAEEncodeForInpaint＋ImageCompositeMasked | Agent 按已装节点补充的工作流，非用户另行导出的原始业务工作流 |
| [supplemental-tiled-upscale-api.json](fixtures/supplemental-tiled-upscale-api.json) | DreamShaper 8；提示词、原图、放大倍数、种子；ImageScaleBy＋UltimateSDUpscaleNoUpscale | Agent 补充；tile 512、20 steps、denoise 0.25 |
| [small-workflow.json](small-workflow.json) | SD1.5 小模型文生图、随机种子；另建 1000 steps 慢任务用于取消/排队 | **不含 LoRA**，成功不能代替原 FLUX＋LoRA 通过 |

未在用户 ComfyUI 网页中先手工跑通三份业务工作流；本次直接通过真实 Atelier API/UI 驱动 ComfyUI 执行，并检查历史和文件。该准备步骤不宣称完成。

## 逐项结果

“通过”只对应本行列明的实际覆盖；“未测”表示原测试条件未完成，即使本机替代测试有结果。

| 编号 | 结果 | 做了什么 / 实际现象 / 是否符合预期 | 截图或证据 |
|---|---|---|---|
| T1-1 | 通过 | 添加隔离 ComfyUI 供应商并点击测试连接；显示 RTX 5080、15.9GB | [连接](shots/T1-1-connection.png) |
| T1-2 | 通过 | 对保存 API 提交 192.168.1.100 地址；HTTP422，明确只支持 127.0.0.1 / localhost。未重复做 UI 地址输入 | [结果](phase1-results.json) |
| T1-3 | 通过 | 对检查 API 提交普通 nodes/links 格式；拒绝并提示 Export (API)。普通格式样例为构造输入 | [结果](phase1-results.json) |
| T1-4 | 不通过 | 原 FLUX 的 in: 字段被找到，但 LoRA 小数误判 int，CR Text 提示词判为 text。补充两流程在线检查无缺节点/模型警告；模型下拉候选来自真实列表。未留齐三份编辑框截图 | [原始检查](inspection.json)、[编辑框](shots/T1-5-edit.png) |
| T1-5 | 通过 | 保存并重新打开含中文名称/输入的工作流，中文正常 | [截图](shots/T1-5-edit.png) |
| T1-6 | 通过 | 删除测试副本的实际输入节点并重导入，出现未匹配提示；保存先禁用，勾确认后启用。未在 ComfyUI 网页删除节点 | [截图](shots/T1-6-removed.png) |
| T2-1 | 不通过 | 修正隔离输入类型后，以原 FLUX＋LoRA 请求 2 张、强度0.8；约269.72s后 ComfyUI 退出，任务结果未确认，无产物。小模型2张成功、种子不同，作为额外证据 | [原失败](shots/T2-1.png)、[替代成功](shots/small-model-double.png) |
| T2-2 | 通过 | 真实创作台选分块放大，不给参考图；发送置灰，显示“需要原图” | [截图](shots/T2-2-missing-reference.png) |
| T2-3 | 通过 | 上传1024×1024图，补充分块放大工作流完成；输出2048×2048，等待约22.16s，页面21s，0¥ | [截图](shots/T2-3.png)、[任务](T2-3-job.json) |
| T2-4 | 通过 | 真实画布打开局部修改，鼠标涂抹并点击生成；HTTP201，产物成功。逐像素比对：完全保护区差异为0，变化bbox为[195,232,316,280]。另做矩形mask测试也通过。费用0 | [涂抹](shots/T2-4-brush-before-submit.png)、[加载后结果](shots/T2-4-final-loaded.png)、[像素](brush-pixel-check.json) |
| T2-5 | 通过 | 真实扩图编辑器点击模型菜单；当前6个ComfyUI工作流均未出现，显示“暂无可用模型”，不可生成 | [菜单](shots/T2-5-model-menu.png) |
| T2-6 | 通过 | 检查本次历史中的产物，Atelier生成输出在 output/atelier/，文件名含job ID；三任务下载文件与Comfy输出逐个SHA256相同，无本次任务相互覆盖。未对用户原有全目录做前后哈希审计 | [文件检查](output-cost-check.json)、[最终映射](final-state.json) |
| T2-7 | 通过 | 真实界面固定种子后，“1张”且禁用数量选择 | [截图](shots/T2-7-fixed-seed.png) |
| T3-1 | 未测 | 开启测试网关操作被自动审批拒绝，未创建成员密钥 | 阻断 B1 |
| T3-2 | 未测 | 网关未开，未验证成员菜单、图标、本机价格标识 | 阻断 B1 |
| T3-3 | 未测 | 未执行成员三类生成及主机网关运行中列表验证 | 阻断 B1 |
| T3-4 | 未测 | 未验证成员允许工作流过滤 | 阻断 B1 |
| T4-1 | 未测 | 原两人场景未执行；本机替代使用SD1.5 1000 steps长任务，真实执行成功 | [排队](shots/T4-three-queue.png) |
| T4-2 | 未测 | 成员/网关位置未测。本机三个任务观察到queued:1、queued:2；取消前项后剩余位置递减，但不能证明成员UI一致 | [本机排队](shots/T4-local-queue.png) |
| T4-3 | 未测 | 两人未测；本机三任务全部成功，耗时105.56s，三个哈希不同且分别匹配对应Comfy产物，无串图 | [完成](shots/T4-three-completed.png)、[映射](final-state.json) |
| T4-4 | 未测 | 缺成功LoRA单任务和双人排队耗时；已记录可测的放大、重绘、小模型和本机三任务耗时 | 下方耗时表 |
| T5-1 | 未测 | 成员场景未测。本机取消排队B，B已停止，A正常完成；队列删除生效 | [事件](events.jsonl)、[界面](shots/T5-local-canceled.png) |
| T5-2 | 未测 | 成员场景未测。本机已停止错误为“已停止”，无扣费字样；严格慢任务测试在Comfy历史确认execution_interrupted | [严格批次](T5-4-strict-batch-job.json)、[历史](comfy-history.json) |
| T5-3 | 通过 | 经Comfy API直接提交独立X，确认运行后提交并取消Atelier C，X正常完成；额外在X运行时发不匹配prompt_id中断也未误停X。使用API代替Comfy网页手工点击 | [严格历史](comfy-history.json)、[C任务](T5-3-strict-C-job.json) |
| T5-4 | 未测 | 原LoRA条件未完成；SD1.5慢任务n=3严格复测，首张KSampler出现execution_interrupted，第二/三张未提交，队列空 | [历史](comfy-history.json)、[任务](T5-4-strict-batch-job.json) |
| T5-5 | 通过 | 记录0.42.0；T5-3严格复测未误停独立X。只能说明本版本，不代表旧版兼容 | [最终状态](final-state.json) |
| T6-1 | 通过 | Comfy进程已退出时主机提交；约4.03s内失败，“主机的 ComfyUI 未启动”，不卡住 | [截图](shots/T6-1.png) |
| T6-2 | 未测 | 未完成成员离线报错验证 | 阻断 B1 |
| T6-3 | 通过 | 实际FLUX运行中进程意外退出，Atelier提示结果未确认；相同启动方式重启后小模型生成恢复。利用真实退出故障，未再主动杀进程重演 | [失败任务](T2-1-job.json)、[恢复任务](small-model-double-job.json) |
| T6-4 | 通过 | 测试副本引用不存在的模型名；失败详情包含HTTP400、prompt_outputs_failed_validation、ckpt_name及缺失文件名。未删改实际模型文件 | [截图](shots/T6-4-missing.png)、[任务](T6-4-missing-job.json) |
| T6-5 | 未测 | 系统代理已开时小模型/放大/重绘均成功，未改代理；原要求重复LoRA成功仍未满足 | [小模型截图](shots/small-model-double.png) |

## 问题与阻断

### P1：LoRA 小数被自动识别为整数（已确认）

复现：导入用户工作流的带标签副本，node4 `LoraLoaderModelOnly.strength_model` 默认值在JSON中是整数 `1`；查看自动声明，然后提交强度 `0.8`。

预期：按ComfyUI字段FLOAT声明为小数，0.8可提交。

实际：`type=int`，但 `step=0.01`；提交HTTP422，`参数类型或选项无效：LoRA强度`。这会阻断文档要求的修改LoRA强度后生成。

原始检查摘录：

```json
{"type":"int","node_id":"4","field":"strength_model","default":1,"min":-100.0,"max":100.0,"step":0.01}
```

证据：[inspection.json](inspection.json)。仅调整隔离工作流输入声明为float以继续测试，未改产品代码。定位线索：`src/character_workflow/lib/comfyui_workflows.py` 中 `_candidate` 对JSON默认值的整数/小数判断。

### P2：CR Text 的 in:提示词未自动映射到 prompt（已确认的识别限制）

复现：node11 `CR Text.text`，标题 `in:提示词`，经连线给CLIPTextEncodeFlux。

预期：本验收文档要求提示词类型正确。

实际：原始检查为 `type=text`。测试中人工将声明改成prompt后才使用创作台主提示词。该问题是自动识别限制，未证明所有第三方文本节点都应被无条件识别为prompt。

证据：[inspection.json](inspection.json) 的 node11。注意 `phase1-results.json` 中该项被脚本共享对象后续修改成prompt，**不能用它代替原始识别证据**；以先写出的inspection.json为准。

### P3：原始 FLUX＋LoRA 执行期间 ComfyUI 进程退出（原因未确认）

复现：工作流FLUX.Krea.FP8_fast＋Xiongdawei_V3，768×1024、30 steps、LoRA0.8、n=2。

任务：`job-20261102134918ea2035ae`；Comfy prompt：`fd938330-6fe6-4ba3-a825-5d2b14cddc26`。

预期：两张成功，0¥，不同种子。

实际：约269.72秒后任务failed、输出为空，`ComfyUI 任务结果未确认`；原进程消失，8188不可用。观察到显存15785MiB/16303MiB、GPU99%。**没有明确CUDA OOM堆栈，不能把显存不足当成已确认根因。**

Comfy日志末尾：

```text
[2026-11-02 21:49:51.486] loaded completely;  4777.54 MB loaded, full load: True
[2026-11-02 21:49:53.018] Requested to load Flux
[2026-11-02 21:52:38.049] loaded completely; 11725.54 MB usable, 11350.07 MB loaded, full load: True
```

证据：[Comfy退出前日志](comfy-before-restart.log)、[主机server.log末100行](host-failure-last100.log)、[失败任务](T2-1-job.json)。最后100行主要为HTTP轮询，没有揭示进程退出原因。

按用户授权换小模型：重启同一ComfyUI安装后，DreamShaper 8 SD1.5的2张生成、放大和重绘均成功。两张小模型种子分别为3093021412824216、8837799053168755。没有再次用原FLUX重压测试，原失败保留。

### B1：自动审批拒绝开启测试网关

计划在隔离主机上开启5198测试网关，以执行T3及成员相关测试。执行工具在启动该动作前被自动审批拒绝，理由：`[Expose Local Services]`。没有换工具或绕过拒绝，网关密钥未创建。

影响：T3全部、双人T4、成员T5-1/2、成员离线T6-2不能完成。本机替代结果不能证明跨成员身份隔离和网关取消转发正确。要完成原文档验收，必须先获得该网关操作的有效工具权限，再补做这些原场景。

## 耗时与费用

| 实测场景 | 耗时 | 备注 |
|---|---:|---|
| 原FLUX＋LoRA，2张请求 | 269.72s后失败 | 未得到任何图；不作为正常性能数据 |
| SD1.5小模型2张 | 58.39s等待，UI57s | 包含模型切换/首次加载，512×512；不含LoRA |
| 分块放大1024→2048 | 22.16s等待，UI21s | 补充工作流，已加载SD1.5 |
| 矩形遮罩局部重绘 | 2.02s轮询等待 | 512×512，模型已热；轮询精度约2s |
| 实际鼠标涂抹局部重绘 | 2.03s轮询等待 | job提交到完成约1.77s |
| 本机同时提交3个长任务 | 105.56s总墙钟 | SD1.5每个1000steps，刻意延长以观测队列；不可当常规工作流耗时 |
| 上述3任务分别提交到完成 | 34.65s / 103.95s / 69.34s | 依提交API返回顺序列出；并发runner入队先后不同，第二/第三完成顺序互换，产物归属正确 |
| Comfy离线失败 | 4.03s | 明确未启动 |

所有18个Atelier任务的预估与实际费用均0.0。参考[final-state.json](final-state.json)。三个长任务的下载文件SHA256各不相同，且与各自job ID的Comfy输出逐项相同。

## 证据解读与剩余条件

- `events.jsonl` 是原始日志，不是最终判决表。通用wait函数把任何非done终态记成“不通过”，因此预期的canceled、离线failed、缺模型failed要看随后针对该测试的判定；不能直接计数这些原始行。
- T1-6第一次只移动节点ID，系统按标题/类型/字段自动重映射成功；测试脚本最初误以为应警告。真正删除节点后警告正常，故不报告误判的bug。
- 较早短任务取消存在“已完成才取消”的竞态；严格复测增加到1000steps，并用execution_interrupted证明真正中断。早期记录不能单独作为中断证据。
- 画布截图一度在媒体加载完成前出现黑框；最终复查3张图片naturalWidth均512、无HTTP错误，加载后截图正常。未据此报告产品缺陷。
- 工作流类型自动识别的七类输入没有穷举所有第三方节点；三份业务工作流中两份是测试补充图，仍需用户实际业务图验收。
- 没有运行make verify/构建/单元测试：本次无产品改动，按文档做真实应用验收，未用测试套件替代真机结果。

原始报告、完整截图、测试脚本和隔离数据保留在本地忽略目录。本目录按用户授权上传报告及其引用的37份证据；未上传运行配置、密钥、浏览器会话或完整data root。机器专属的用户下载路径和验收根路径已用占位符替代；JSON结构、任务ID、结果与哈希保持原样。没有发飞书消息或回写外部知识库。ComfyUI已恢复运行，最终无运行或排队任务。收尾尝试通过preview_stop停止隔离测试主机5175和成员5176，两个操作均被自动审批以 `[Interfere With Workloads]` 拒绝；没有换方式绕过，因此两实例保留运行。正式5174始终未动。

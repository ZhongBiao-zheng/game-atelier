# 图片尺寸能力核查

核查日期：2026-09-09。生产目录：`src/character_workflow/image_size_catalog.json`，Python与前端同读；不要在组件或Canvas偏好另写白名单。

## 当前已接入范围

本次核对本地24个图片配置项：Tuzi的GPT Image 2/2.5、Nano Pro/2及固定2K/4K、Seedream4.5、MJ；OpenAI-HK的GPT Image 2/Sunburst/Flare和Nano/2/HD；火山Seedream4.5/5与词元跳动Seedream5 Lite/Pro；OpenRouter的GPT2、Seedream4.5、Gemini3 Pro和Flux2 Pro。另按OpenRouter公开Images目录核对52个精确型号的尺寸描述。

| 渠道与模型 | 比例策略 | 分辨率策略 |
|---|---|---|
| Tuzi Nano Pro/2及固定档位 | 十项：1:1、4:3、3:4、16:9、9:16、3:2、2:3、4:5、5:4、21:9 | 保留现有quality与固定型号计费路由 |
| OpenAI-HK Nano | 保留原七项；文档未核实4:5/5:4/21:9，不能套用Tuzi | 不改变已有路由 |
| GPT Image 2、Seedream4.5/5、MJ | 十项常用预设，增加4:5/5:4；GPT与Seedream仍保留自定义像素 | 保留各型号原有像素上下限与档位；Seedream新增预设不回落方图 |
| OpenRouter | 每个精确型号使用公开supported_parameters.aspect_ratio，含文档支持的AUTO | 使用supported_parameters.resolution；可选512/1K/2K/4K取决于型号，默认不指定，避免静默改变费用 |

OpenRouter并非所有模型都支持21:9：例如GPT Image 1只声明1:1/3:2/2:3/AUTO，不能继续给它通用八项。Gemini3 Pro共十项；Gemini3.1 Flash Image共十四项，包括1:4/4:1/1:8/8:1；Seedream4.5十七项加AUTO，含9:21与手机长屏比例。缺少尺寸能力声明的型号不发尺寸参数。未知/将来新增型号沿用旧保守预设，**不代表已验证完整**，更新目录后才扩大能力。

连续像素或任意整数比例模型不存在有限的“所有尺寸列表”；预设仅是快捷入口，不宣称十项穷尽全部比例。DALL-E、Seedream4.0不在当前配置范围，本轮没有调整其遗留协议。

## 传输与维护

- UI、偏好、Job保留冒号比例；Tuzi/HK已有Nano Images请求在出站边界按文档转`21x9`等形式。OpenRouter继续发`aspect_ratio: 21:9`，不得全局替换。
- 保存偏好、冻结提交和前端共用目录，合法比例/档位不能被悄悄替换为1:1。Gemini canonical使用独立尺寸识别，不改变通用family、参考数量、quality或端点。
- OpenRouter“默认”分辨率=省略resolution。选具体档位才发送；历史还原同时保留512/1K/2K/4K。AUTO尺寸仍省略ratio/resolution。
- 厂商更新时，重新读取下列来源，更新共享目录及核查日期，运行`tests/test_image_size_catalog.py`与`web/src/lib/imageSizeCatalog.test.ts`的全模型参数矩阵，最后`make verify`。目录是有来源的版本快照，不承诺未来厂商变化自动生效。
- 本次未付费出图；文档/公开能力目录核对、mock请求payload和隔离真实页面验证不能冒充厂商实测。

来源：[Tuzi兼容Images](https://tuzi-api.apifox.cn/343646956e0)、[Tuzi异步Nano](https://tuzi-api.apifox.cn/412175236e0)、[HK Nano](https://www.openai-hk.com/docs/en/openai/nano-banana.html)、[Google Gemini](https://ai.google.dev/gemini-api/docs/image-generation)、[OpenRouter Images能力目录](https://openrouter.ai/api/v1/images/models)、[OpenRouter尺寸参数](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)、[MJ版本限制](https://docs.midjourney.com/hc/en-us/articles/32199405667853-Version)。

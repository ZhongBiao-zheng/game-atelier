# 视频处理

在插件设置中启用「视频处理」。接口使用本机会话。提交和取消还需要画布编辑权。请求体为
`{"project_id":"…","params":{…}}`，响应体为 `{"result":{…}}`。插件默认关闭。

所有接口均为 `POST /api/plugins/video-tools/routes/<操作>`。

| 操作 | params | result |
|---|---|---|
| probe | `version_id` | 首次使用试编码并解码。返回版本号、显示宽高、时长（duration_ms）、音轨数、平均与标称帧率分数、codec、pix_fmt |
| submit | `request_id`、`version_id`、`operation` | 立即返回带 operation_id 的操作记录。重送同一请求号和参数可取回原记录，参数冲突为 HTTP 409 |
| get | `operation_id` | 返回本项目的操作记录。编码中可读 processed_ms |
| cancel | `operation_id` | 返回终态。若画布已提交则返回 succeeded 及产物标识 |

时间裁剪示例为 `{"kind":"video_trim","start_ms":500,"end_ms":1500}`。起点包含，终点排除，按呈现时间剪取音视频。
压缩示例为 `{"kind":"video_compress","max_long_edge":1280,"quality":"standard"}`。长边范围 2–8192 像素，只缩小，输出对齐到偶数像素。

状态依次可为 queued、running、committing、succeeded、failed、canceled。成功记录包含 node_id、version_id、original_bytes 与 encoded_bytes。
当压缩结果未变小时，成功记录带 message 和两项字节数，界面保留原视频。失败读 error_code 与 message；中断的操作用新 request_id 显式重试。
不存在的版本或操作返回 404，跨项目素材返回 403。源素材的路径由宿主按版本解析。
探测错误在 HTTP detail 中返回 code 与 message；异步处理错误保存在操作记录。程序缺失、校验不符、启动失败、系统编码器不可用、损坏输出、存储问题分别使用
binary_missing、binary_integrity、binary_launch、system_encoder、corrupt_output、storage。机器未提供相应运行包时为 unsupported_platform。
输入视频解码支持 H.264、HEVC、VP8、VP9，至多一条 AAC 或 Opus 音轨。不支持的编码返回 unsupported_codec 和「不支持这种视频编码」。

两个系统编码器使用相同的目标视频码率。以首批 320×192 合成片试测的 240/420/700 kbps 为基准，按实际输出像素数线性换算，四舍五入并设 64 kbps 下限。
这维持每帧相近的单位像素预算，实际大小取决于内容与系统编码器。下表为目标 kbps。

| 输出像素 | small | standard | high |
|---|---:|---:|---:|
| 320×192 | 240 | 420 | 700 |
| 640×360 | 900 | 1575 | 2625 |
| 1280×720 | 3600 | 6300 | 10500 |
| 1920×1080 | 8100 | 14175 | 23625 |

VideoToolbox 使用 h264_videotoolbox、yuv420p、allow_sw=1；Media Foundation 使用 h264_mf、NV12 输入、rate_control=cbr。
输出为前置 moov 的 H.264/yuv420p MP4，有声输入转 AAC，无声输入保持无声。旋转方向烘入像素，输出方形像素。普通恒定帧率沿用输入，可变帧率按时间戳采样为 24 fps。

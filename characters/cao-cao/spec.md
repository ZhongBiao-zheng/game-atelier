---
id: cao-cao
name: 曹操
project: ma-jiang-you-xi
created: 2026-05-28
---

## identity
- role: 三国武将 / 狼形拟人角色
- archetype: 魏主曹操（枭雄，偏谋略型）
- temperament: 狡黠强势、阴沉危险、掌控感强

## visual_dna
- style: 卡通三国武将立绘（粗轮廓线 + 色块清晰，适合游戏角色头像和半身展示）
- palette: 深紫（外袍主）/ 黑色（大面积毛领）/ 金色（冠饰/边饰）/ 红色（系带/胸饰核心）/ 白色（内摆）
- body: 狼形拟人武将
- head: 灰蓝狼头、黑色眉斑压低、黄色竖瞳、露齿凶狠表情；头顶金色冠饰、红色系带沿脸侧垂下
- props: 右侧短剑/令牌式道具（武将身份辅助锚点）

## anchors
1. 灰蓝狼头+黄色竖瞳+黑色眉斑——物种身份不可改变
2. 深紫外袍+大面积黑色毛领——权臣气场核心
3. 金色冠饰+红色系带——贵气与危险并存
4. 手部前伸的掌控姿态——枭雄特质标志

## asset.portrait
- size: 1024×1024
- angle: 半身正面
- background: 纯白简约
- pose: 手部前伸掌控姿态

## asset.promo
- size: 1536×1024
- format: 横版 KV

## asset.turnaround
- size: 1536×1024
- view_set: 正面/侧面/背面 + 短剑正面小图（右侧 1/4 区域）
- pose: 双臂微微下倾 ~15° 的 T-pose，全身含脚底，衣服盖过脚
- background: 浅灰底色细线网格，头顶线/腰线/脚底线辅助基线
- downstream_use: 建模
- coloring_style: 平涂
- v1: job-20260529100226e049e5b5 · gpt-image-2 · 1536×1024
- v2: job-2026052910201478a2d4f2 · gpt-image-2 · 1536×1024 · 简化 prompt（参考图模式）+ 去排除段

## prohibit
- 写实风格
- 改变狼形特征（灰蓝狼头、黄色竖瞳不可改变）
- 改变掌控姿态

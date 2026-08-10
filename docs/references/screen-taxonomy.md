# Screen Taxonomy（玩家旅程审计表）

> 供 `ui-screens` skill 推页面清单时引用。**按项目适配选择，不要默认全量加入**——
> 只选服务题材 / 平台 / 核心循环 / 留存 / 商业模式的页面。
> 整理自 [game-ui-design-workflow](https://github.com/guiguiyan930-source/game-ui-design-workflow)（MIT）。

---

## 玩家旅程 8 步审计

按顺序逐步检查「这一步玩家要完成什么、缺哪页会断」：

1. **启动与首次进入**：启动、登录、公告、选服、创建角色、教程。
2. **核心玩法**：大厅、任务、准备、关卡、战斗 HUD、暂停、结算。
3. **成长管理**：角色、装备、技能、突破、背包、图鉴、成就。
4. **经济商业**：商店、抽卡、通行证、订阅、兑换、广告奖励。
5. **活动回流**：签到、日常、活动中心、限时挑战、回归。
6. **社交竞争**：好友、公会、聊天、邮件、档案、排行、赛季。
7. **策略表达**：编队、卡组、预设、天赋、外观、家园。
8. **支持设置**：设置、控制、无障碍、账号、客服、兑换码。

## 页面分类池（候选 screen-id）

需要完整分类审计时用；普通延展不必全量载入。

| 分类 | 候选页面 |
|---|---|
| entry | splash, login, announcement, server-select, character-create, opening-story, tutorial-overlay |
| core | home, quest, preparation, stage-select, battle-hud, pause, fail-revive, settlement |
| growth | inventory, character, equipment, skills, ascension, companion, achievement, codex |
| economy | shop, gacha, battle-pass, subscription, currency-exchange, ad-reward |
| live-ops | sign-in, daily-weekly, event-hub, limited-challenge, seasonal, returner |
| social | friends, guild, guild-activity, chat, mail, player-profile |
| competition | pvp-lobby, matchmaking, leaderboard, match-history, season-summary, tournament |
| strategy | formation, deck-builder, loadout, talent-planner, ai-tactics |
| expression | wardrobe, housing, photo-mode, replay, user-content |
| support | settings, controls, accessibility, account, customer-support, redeem-code |

## 优先级三档

- `must-have`：没有它就无法完成核心循环或安全交付首版。
- `genre-specific`：由玩法决定（如卡牌编队、射击配装）。
- `optional`：增强留存 / 表达 / 运营，但不阻断首版。

## 每个候选页的五问

1. 哪个玩家循环的转场需要它？
2. 这一页的首要动作是什么？
3. 它属于首版必需、题材深度、还是可选留存？
4. 能否合并进另一页而不藏起高频动作？
5. 空 / 锁定 / 过期 / 断网 / 资源不足这些态哪些适用？

## 结构约束（选页时顺带检查）

- 大厅只保留有限高优入口，次级活动统一进活动中心。
- 从首次进入到日常回流的路径必须闭合；结算能回到成长或下一局。
- 页面没有无入口或无出口的孤岛。
- 页面数量与项目阶段相称——首版清单宁缺毋滥。

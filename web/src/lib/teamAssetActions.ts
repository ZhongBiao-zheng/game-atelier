/** 团队资产动作（提醒 toast →「复刻」/「看看」）的页面间约定。
 *
 *  发起方先 `dispatchTeamAssetAction`：当前页面（Studio / 画布）监听到就 `preventDefault()` 认领并就地处理；
 *  没人认领时发起方导航到 `/studio${teamAssetActionSearch(action)}`，Studio 挂载时用
 *  `teamAssetActionFromSearch` 读一次再清掉查询串。 */
export const TEAM_ASSET_ACTION_EVENT = 'atelier:team-asset-action';

export interface TeamAssetAction {
  library_id: string;
  asset_id: string;
  action: 'reproduce' | 'open';
}

const ASSET_PARAM = 'team_asset';
const ACTION_PARAM = 'team_action';
const ACTIONS: ReadonlySet<string> = new Set<TeamAssetAction['action']>(['reproduce', 'open']);

/** 有监听者 `preventDefault()` 认领则返回 true。 */
export function dispatchTeamAssetAction(action: TeamAssetAction): boolean {
  const event = new CustomEvent<TeamAssetAction>(TEAM_ASSET_ACTION_EVENT, { detail: action, cancelable: true });
  return !window.dispatchEvent(event);
}

export function teamAssetActionFromSearch(search: string): TeamAssetAction | null {
  const params = new URLSearchParams(search);
  const asset = params.get(ASSET_PARAM);
  const action = params.get(ACTION_PARAM);
  if (!asset || !action || !ACTIONS.has(action)) return null;
  const parts = asset.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { library_id: parts[0], asset_id: parts[1], action: action as TeamAssetAction['action'] };
}

/** `'?team_asset=lib:ta&team_action=reproduce'`；id 各自编码，分隔用的冒号保持原样。 */
export function teamAssetActionSearch(action: TeamAssetAction): string {
  const asset = `${encodeURIComponent(action.library_id)}:${encodeURIComponent(action.asset_id)}`;
  return `?${ASSET_PARAM}=${asset}&${ACTION_PARAM}=${encodeURIComponent(action.action)}`;
}

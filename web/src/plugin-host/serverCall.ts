import { ApiError, requestJson } from '@/api/http';
import { PluginServerError } from './broker';

export interface PluginRouteCall {
  pluginId: string;
  pluginName: string;
  projectId: string;
  nodeId: string;
  path: string;
  params: unknown;
  versionIds: string[];
  /** 把页面上还没保存的编辑落盘。新建的插件节点要先存到服务端，服务端才认它。 */
  savePendingEdits?: () => Promise<void>;
}

/** 调本插件的服务端路由。服务端不信这里：它会重新核对插件是否启用、项目是否批准、节点与素材的归属。 */
export async function callPluginRoute(call: PluginRouteCall): Promise<unknown> {
  if (call.savePendingEdits) {
    try {
      await call.savePendingEdits();
    } catch {
      throw new PluginServerError('画布还没保存好，请稍后重试');
    }
  }
  try {
    const body = await requestJson<{ result: unknown }>(
      `/api/plugins/${encodeURIComponent(call.pluginId)}/routes${call.path}`, call.pluginName, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: call.projectId, node_id: call.nodeId, inputs: call.versionIds, params: call.params }),
      });
    return body.result;
  } catch (error) {
    if (error instanceof ApiError && error.reason) throw new PluginServerError(error.reason);
    throw error;
  }
}

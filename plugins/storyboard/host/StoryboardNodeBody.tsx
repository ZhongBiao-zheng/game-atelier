import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { canvasMediaUrlAtWidth } from '@/api/canvas';
import { ImageIcon } from '@/components/ui/icons';
import {
  STORYBOARD_PAYLOAD_MAX_BYTES, STORYBOARD_TOO_LARGE, formatStoryboardDuration, isStoryboardNode,
  normalizeStoryboardPayload, resolveStoryboardBinding, storyboardPayloadBytes, storyboardPayloadOf,
  storyboardAutoHeight, storyboardShotLabel, storyboardTotalDuration, type StoryboardNode, type StoryboardPayload, type StoryboardShot,
} from './canvasStoryboard';
import type { CanvasContentVersion, CanvasNode, JsonValue } from '@/schema/canvas';

import { StoryboardEditor } from './StoryboardEditor';
import type { ShotGenerationKind, ShotGenerationPlan } from './storyboardGeneration';

/** 分镜节点向画布要的东西。分镜由宿主直接渲染，不经过插件注册表、批准与沙箱。 */
export interface StoryboardHost {
  projectId: string;
  sharedMediaUrl?: (versionId: string) => string;
  readOnly?: boolean;
  /** 只在当前文档里找节点。 */
  findNode: (id: string) => CanvasNode | undefined;
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  recordHistory: () => void;
  selectNode?: (id: string) => void;
  reportError?: (message: string) => void;
  /** 把页面上还没保存的编辑落盘（解析剧本前用：服务端只读已保存的剧本）。 */
  savePendingEdits?: () => Promise<void>;
  /** 当前文档里的全部节点。 */
  listNodes?: () => readonly CanvasNode[];
  /** 按当前文档算一份生成计划（不建节点、不提交）；确认弹窗只显示它。 */
  planShots?: (nodeId: string, shotIds: readonly string[], kind: ShotGenerationKind, count: number) => ShotGenerationPlan | null;
  /** 应用确认过的计划并逐镜提交。 */
  runShots?: (plan: ShotGenerationPlan) => Promise<void>;
  /** 这个节点最近一次生成是否失败。 */
  lastRunFailed?: (nodeId: string) => boolean;
}

export type ShotMediaState = 'none' | 'running' | 'done' | 'failed';
const STATE_LABEL: Record<ShotMediaState, string> = { none: '未生成', running: '生成中', done: '已完成', failed: '失败' };
const STATE_COLOR: Record<ShotMediaState, string> = {
  none: 'bg-status-pending', running: 'bg-status-running', done: 'bg-status-done', failed: 'bg-status-failed',
};

/** 镜头的图或视频处在哪一步。绑定的节点不存在或类型不符时算未生成。 */
export function shotMediaState(host: StoryboardHost, nodeId: string | null, type: 'image' | 'video'): ShotMediaState {
  const node = resolveStoryboardBinding(host.findNode, nodeId, type);
  if (!node) return 'none';
  if (node.data.active_run_id) return 'running';
  if (host.resolveVersion(node.data.current_version_id)?.kind === type) return 'done';
  return host.lastRunFailed?.(node.id) ? 'failed' : 'none';
}

export function ShotStateDot({ state, label }: { state: ShotMediaState; label: string }) {
  return <span role="img" aria-label={`${label}${STATE_LABEL[state]}`} className={`size-1.5 shrink-0 rounded-full ${STATE_COLOR[state]}`} />;
}

// 节点工具条的「编辑」在卡片之外，用一个极小的外部状态请求打开弹窗。
export type StoryboardEditorTab = 'shots' | 'entities' | 'script';
let editRequest: { nodeId: string; tab: StoryboardEditorTab } | null = null;
const editListeners = new Set<() => void>();
function setEditRequest(request: typeof editRequest) {
  editRequest = request;
  editListeners.forEach(listener => listener());
}
function subscribeEditRequest(listener: () => void) {
  editListeners.add(listener);
  return () => { editListeners.delete(listener); };
}
export function requestStoryboardEdit(nodeId: string, tab: StoryboardEditorTab = 'shots') {
  setEditRequest({ nodeId, tab });
}

/** 镜头行的摘要：景别 · 运镜 · 时长，空项不占位。 */
export function storyboardShotMeta(shot: StoryboardShot): string {
  return [shot.shot_size, shot.camera, formatStoryboardDuration(shot.duration_s)].filter(Boolean).join(' · ');
}

export function useStoryboardImageUrl(host: StoryboardHost, imageNodeId: string | null): string | null {
  const image = resolveStoryboardBinding(host.findNode, imageNodeId, 'image');
  const version = host.resolveVersion(image?.data.current_version_id);
  if (version?.kind !== 'image') return null;
  return host.sharedMediaUrl?.(version.version_id) ?? canvasMediaUrlAtWidth(host.projectId, version.version_id, 256);
}

export function StoryboardThumb({ host, imageNodeId }: { host: StoryboardHost; imageNodeId: string | null }) {
  const url = useStoryboardImageUrl(host, imageNodeId);
  return <span className="grid h-9 w-16 shrink-0 place-items-center overflow-hidden rounded-sm border border-border bg-popover text-subtle-foreground">
    {url ? <img src={url} alt="" loading="lazy" draggable={false} className="size-full object-cover" /> : <ImageIcon size="sm" />}
  </span>;
}

/**
 * 分镜节点的内容区：镜头列表。单击一行定位到该镜的图片节点，双击打开编辑弹窗。
 * 载荷当不可信数据：只走 normalizeStoryboardPayload，文字一律作为文本渲染。
 */
export function StoryboardNodeBody({ node, host }: { node: StoryboardNode; host: StoryboardHost }) {
  const [opened, setOpened] = useState(false);
  const request = useSyncExternalStore(subscribeEditRequest, () => editRequest);
  const requested = request?.nodeId === node.id;
  const editing = !host.readOnly && (opened || requested);
  const setEditing = (open: boolean) => {
    setOpened(open);
    if (!open && requested) setEditRequest(null);
  };
  const payload = useMemo(() => storyboardPayloadOf(node), [node]);
  const { updateNode, reportError } = host;
  const write = useCallback((next: StoryboardPayload) => {
    const normalized = normalizeStoryboardPayload(next);
    if (storyboardPayloadBytes(normalized) > STORYBOARD_PAYLOAD_MAX_BYTES) {
      reportError?.(STORYBOARD_TOO_LARGE);
      return false;
    }
    updateNode(node.id, current => {
      if (!isStoryboardNode(current)) return current;
      // 高度跟着镜头数走；画师手动改过高度（不等于按旧镜头数算出的值）就不再动它。
      const previous = storyboardAutoHeight(storyboardPayloadOf(current).shots.length);
      const size = current.size && current.size.height === previous
        ? { ...current.size, height: storyboardAutoHeight(normalized.shots.length) } : current.size;
      return { ...current, size, data: { ...current.data, payload: normalized as unknown as JsonValue } };
    });
    return true;
  }, [node.id, updateNode, reportError]);

  return <div className="flex size-full min-h-44 flex-col" onDoubleClick={() => { if (!host.readOnly) setEditing(true); }}>
    <p className="shrink-0 border-b border-border px-3 py-2 text-xs tabular-nums text-muted-foreground">
      {payload.shots.length} 镜 · {formatStoryboardDuration(storyboardTotalDuration(payload))}
    </p>
    {payload.shots.length === 0
      ? <p className="grid flex-1 place-items-center px-4 text-center text-xs text-muted-foreground">{host.readOnly ? '暂无镜头' : '双击添加镜头'}</p>
      : <ol className="nowheel min-h-0 flex-1 overflow-y-auto">
        {payload.shots.map((shot, index) => {
          const image = resolveStoryboardBinding(host.findNode, shot.image_node_id, 'image');
          return <li key={shot.id} data-storyboard-shot={shot.id}
            className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
            onClick={() => { if (image) host.selectNode?.(image.id); }}>
            <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">{storyboardShotLabel(index)}</span>
            <StoryboardThumb host={host} imageNodeId={shot.image_node_id} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs tabular-nums text-muted-foreground">{storyboardShotMeta(shot)}</span>
              <span className="block truncate text-sm text-foreground">{shot.visual || '未填写画面'}</span>
            </span>
            <ShotStateDot state={shotMediaState(host, shot.image_node_id, 'image')} label="图片" />
            <ShotStateDot state={shotMediaState(host, shot.video_node_id, 'video')} label="视频" />
          </li>;
        })}
      </ol>}
    <StoryboardEditor open={editing} onOpenChange={setEditing} initialTab={requested ? request.tab : 'shots'} title={node.title} payload={payload} host={host} nodeId={node.id} write={write} />
  </div>;
}

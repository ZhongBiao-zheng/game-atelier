import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { canvasMediaUrlAtWidth } from '@/api/canvas';
import { ImageIcon } from '@/components/ui/icons';
import {
  STORYBOARD_PAYLOAD_MAX_BYTES, STORYBOARD_TOO_LARGE, formatStoryboardDuration, isStoryboardNode,
  normalizeStoryboardPayload, resolveStoryboardBinding, storyboardPayloadBytes, storyboardPayloadOf,
  storyboardShotLabel, storyboardTotalDuration, type StoryboardNode, type StoryboardPayload, type StoryboardShot,
} from '@/lib/canvasStoryboard';
import type { CanvasContentVersion, CanvasNode, JsonValue } from '@/schema/canvas';

import { StoryboardEditor } from './StoryboardEditor';

/** 分镜节点向画布要的东西。分镜由宿主直接渲染，不经过插件注册表、批准与沙箱。 */
export interface StoryboardHost {
  projectId: string;
  /** 只在当前文档里找节点。 */
  findNode: (id: string) => CanvasNode | undefined;
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  recordHistory: () => void;
  selectNode: (id: string) => void;
  reportError?: (message: string) => void;
}

// 节点工具条的「编辑」在卡片之外，用一个极小的外部状态请求打开弹窗。
let editRequest: string | null = null;
const editListeners = new Set<() => void>();
function setEditRequest(nodeId: string | null) {
  editRequest = nodeId;
  editListeners.forEach(listener => listener());
}
function subscribeEditRequest(listener: () => void) {
  editListeners.add(listener);
  return () => { editListeners.delete(listener); };
}
export function requestStoryboardEdit(nodeId: string) {
  setEditRequest(nodeId);
}

/** 镜头行的摘要：景别 · 运镜 · 时长，空项不占位。 */
export function storyboardShotMeta(shot: StoryboardShot): string {
  return [shot.shot_size, shot.camera, formatStoryboardDuration(shot.duration_s)].filter(Boolean).join(' · ');
}

export function useStoryboardImageUrl(host: StoryboardHost, imageNodeId: string | null): string | null {
  const image = resolveStoryboardBinding(host.findNode, imageNodeId, 'image');
  const version = host.resolveVersion(image?.data.current_version_id);
  return version?.kind === 'image' ? canvasMediaUrlAtWidth(host.projectId, version.version_id, 256) : null;
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
  const requested = useSyncExternalStore(subscribeEditRequest, () => editRequest === node.id);
  const editing = opened || requested;
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
    updateNode(node.id, current => isStoryboardNode(current)
      ? { ...current, data: { ...current.data, payload: normalized as unknown as JsonValue } } : current);
    return true;
  }, [node.id, updateNode, reportError]);

  return <div className="flex size-full min-h-44 flex-col" onDoubleClick={() => setEditing(true)}>
    <p className="shrink-0 border-b border-border px-3 py-2 text-xs tabular-nums text-muted-foreground">
      {payload.shots.length} 镜 · {formatStoryboardDuration(storyboardTotalDuration(payload))}
    </p>
    {payload.shots.length === 0
      ? <p className="grid flex-1 place-items-center px-4 text-center text-xs text-muted-foreground">双击添加镜头</p>
      : <ol className="nowheel min-h-0 flex-1 overflow-y-auto">
        {payload.shots.map((shot, index) => {
          const image = resolveStoryboardBinding(host.findNode, shot.image_node_id, 'image');
          return <li key={shot.id} data-storyboard-shot={shot.id}
            className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
            onClick={() => { if (image) host.selectNode(image.id); }}>
            <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">{storyboardShotLabel(index)}</span>
            <StoryboardThumb host={host} imageNodeId={shot.image_node_id} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs tabular-nums text-muted-foreground">{storyboardShotMeta(shot)}</span>
              <span className="block truncate text-sm text-foreground">{shot.visual || '未填写画面'}</span>
            </span>
          </li>;
        })}
      </ol>}
    <StoryboardEditor open={editing} onOpenChange={setEditing} title={node.title} payload={payload} host={host} write={write} />
  </div>;
}

import type { CreationAssetSaveRequest } from '@/components/assets/CreationAssetPanel';
import type { TeamShareDialogRequest } from '@/components/studio/TeamShareDialog';
import { promptToAssetSegments } from '@/lib/promptVariables';
import type {
  CanvasContentNode,
  CanvasContentVersion,
  CanvasMediaVersion,
  CanvasNode,
} from '@/schema/canvas';
import type { GenerationRecipe } from '@/schema/creationAssets';
import {
  canvasNodeRenderedSize,
  placeCanvasNodeWithoutOverlap,
  type CanvasPlacementBounds,
} from './canvasEditorModel';
import type { RecipeModelMatch } from './studioRecipe';

type CanvasVisualVersion = CanvasMediaVersion & { kind: 'image' | 'video' };

function isVisualVersion(version: CanvasContentVersion | null | undefined): version is CanvasVisualVersion {
  return version?.kind === 'image' || version?.kind === 'video';
}

/** 工具条「保存」：文本存提示词，图片 / 视频存媒体或生成资产；音频没有对应的资产类型。 */
export function isSavableCanvasVersion(version: CanvasContentVersion | null | undefined): boolean {
  return version?.kind === 'text' || isVisualVersion(version);
}

/** 工具条「分享」：只有生成出来的图片 / 视频带配方。 */
export function isShareableCanvasVersion(version: CanvasContentVersion | null | undefined): version is CanvasVisualVersion {
  return isVisualVersion(version) && version.origin.kind === 'job_output';
}

function canvasResultSource(node: CanvasContentNode, version: CanvasContentVersion, projectId: string) {
  return {
    kind: 'canvas_result' as const,
    canvas_project_id: projectId,
    node_id: node.id,
    version_id: version.version_id,
  };
}

export function canvasNodeSaveRequest({ node, version, projectId, previewUrl, requestId }: {
  node: CanvasContentNode;
  version: CanvasContentVersion;
  projectId: string;
  previewUrl: string;
  requestId: string;
}): { libraryMode: 'prompts' | 'assets'; request: CreationAssetSaveRequest } | null {
  if (version.kind === 'text') {
    return {
      libraryMode: 'prompts',
      request: { requestId, kind: 'prompt', title: node.title, segments: promptToAssetSegments(version.text), projectId },
    };
  }
  if (!isVisualVersion(version)) return null;
  // 画布媒体 URL 不带后缀（托管模式还带 media_token），类型必须显式给。
  if (version.origin.kind === 'job_output') {
    return {
      libraryMode: 'assets',
      request: {
        requestId, kind: 'media', title: node.title, previewUrl, mediaKind: version.kind, projectId,
        source: canvasResultSource(node, version, projectId),
      },
    };
  }
  return {
    libraryMode: 'assets',
    request: {
      requestId, kind: 'media', title: node.title, sourcePath: `canvases/${projectId}/${version.path}`,
      previewUrl, mediaKind: version.kind, projectId,
    },
  };
}

export function canvasNodeShareRequest({ node, version, projectId, previewUrl }: {
  node: CanvasContentNode;
  version: CanvasContentVersion;
  projectId: string;
  previewUrl: string;
}): TeamShareDialogRequest | null {
  if (!isShareableCanvasVersion(version)) return null;
  return {
    source: canvasResultSource(node, version, projectId),
    defaultTitle: node.title,
    previewUrl: version.kind === 'image' ? previewUrl : null,
  };
}

/** 服务端建好的一组节点（复刻：参考一列在左、配置在右）作为整体避让：按包围盒只找一次空位，
 *  所有节点同一位移平移，组内相对布局不变、彼此不判重叠。 */
export function placeCanvasNodeGroupWithoutOverlap(
  group: readonly CanvasNode[],
  existing: readonly CanvasNode[],
  versions: Readonly<Record<string, CanvasContentVersion>>,
  bounds?: CanvasPlacementBounds,
): CanvasNode[] {
  if (!group.length) return [];
  const sizeOf = (node: CanvasNode) => canvasNodeRenderedSize(node, versions);
  const boxes = group.map(node => ({ position: node.position, size: sizeOf(node) }));
  const left = Math.min(...boxes.map(box => box.position.x));
  const top = Math.min(...boxes.map(box => box.position.y));
  const right = Math.max(...boxes.map(box => box.position.x + box.size.width));
  const bottom = Math.max(...boxes.map(box => box.position.y + box.size.height));
  const target = placeCanvasNodeWithoutOverlap(
    { x: left, y: top },
    existing,
    { width: right - left, height: bottom - top },
    bounds,
    sizeOf,
  );
  const dx = target.x - left;
  const dy = target.y - top;
  if (!dx && !dy) return [...group];
  return group.map(node => ({ ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }));
}

export function canvasReproduceNotices(
  recipe: GenerationRecipe,
  match: RecipeModelMatch | null,
  warnings: readonly string[],
): string[] {
  return [...(match ? [] : [`本机没有 ${recipe.model}`]), ...warnings];
}

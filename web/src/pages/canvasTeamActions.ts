import type { CreationAssetSaveRequest } from '@/components/assets/CreationAssetPanel';
import type { TeamShareDialogRequest } from '@/components/studio/TeamShareDialog';
import { promptToAssetSegments } from '@/lib/promptVariables';
import type { CanvasContentNode, CanvasContentVersion, CanvasMediaVersion, CanvasSize } from '@/schema/canvas';
import type { GenerationRecipe } from '@/schema/creationAssets';
import { CANVAS_DEFAULT_NODE_SIZE } from './canvasEditorModel';
import type { RecipeModelMatch } from './studioRecipe';

type CanvasVisualVersion = CanvasMediaVersion & { kind: 'image' | 'video' };

/** 与服务端复刻布局（canvas_reproduce.py）的列距 / 行距同量级，只用来找一块够大的空位。 */
const REPRODUCE_COLUMN_GAP = 96;
const REPRODUCE_ROW_GAP = 32;

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

/** 复刻出来的整组节点（参考一列在左、配置节点在右）大致占多大：服务端不避让，空位由前端找。 */
export function canvasReproduceFootprint(recipe: GenerationRecipe): CanvasSize {
  const references = recipe.inputs.filter(input => input.role === 'reference').length;
  if (!references) return CANVAS_DEFAULT_NODE_SIZE;
  return {
    width: CANVAS_DEFAULT_NODE_SIZE.width * 2 + REPRODUCE_COLUMN_GAP,
    height: references * (CANVAS_DEFAULT_NODE_SIZE.height + REPRODUCE_ROW_GAP),
  };
}

export function canvasReproduceNotices(
  recipe: GenerationRecipe,
  match: RecipeModelMatch | null,
  warnings: readonly string[],
): string[] {
  return [...(match ? [] : [`本机没有 ${recipe.model}`]), ...warnings];
}

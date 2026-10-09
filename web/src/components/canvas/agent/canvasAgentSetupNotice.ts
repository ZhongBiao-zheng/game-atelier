import type {
  CanvasAgentChatModel, CanvasAgentCreationMode, CanvasAgentGenerationModel, CanvasAgentModelRef,
} from '@/schema/canvas';

/** 输入框上方的配置提示：发之前就说清楚缺什么、去哪补，而不是等 Agent 回一句「没有可用模型」。 */
export interface CanvasAgentSetupNotice {
  text: string;
  /** settings：去设置页配 Key；auto：把模型偏好改回自动。 */
  action: 'settings' | 'auto';
}

const KIND_LABELS = { image: '图像', video: '视频' } as const;

export function canvasAgentSetupNotice({ chatModels, generationModels, mode, auto, preferred }: {
  /** null = 还没读到，不提示。 */
  chatModels: CanvasAgentChatModel[] | null;
  generationModels: CanvasAgentGenerationModel[] | null;
  mode: CanvasAgentCreationMode;
  auto: boolean;
  preferred: CanvasAgentModelRef[];
}): CanvasAgentSetupNotice | null {
  if (chatModels && chatModels.length === 0) {
    return { text: '还没有可用的对话模型，需要在 Key 里启用文本模型', action: 'settings' };
  }
  if (!generationModels) return null;
  const kinds = mode === 'all' ? (['image', 'video'] as const) : [mode];
  const available = kinds.filter(kind => generationModels.some(item => item.kind === kind));
  if (available.length === 0) {
    const label = mode === 'all' ? '图像或视频' : KIND_LABELS[mode];
    return { text: `还没有配置${label}模型`, action: 'settings' };
  }
  if (auto) return null;
  const chosen = available.filter(kind => generationModels.some(item => item.kind === kind
    && preferred.some(ref => ref.alias === item.alias && ref.model === item.model)));
  if (chosen.length > 0) return null;
  const label = mode === 'all' ? '任何' : KIND_LABELS[mode];
  return { text: `模型偏好里没选${label}模型，Agent 无法生成`, action: 'auto' };
}

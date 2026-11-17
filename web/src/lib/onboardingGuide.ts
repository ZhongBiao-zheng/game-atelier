/** 首次启动引导的推荐厂商与外链。换推荐厂商、改链接只改这个文件（presetId 指向 providerPresets）。 */
import { modelsForKind } from '@/pages/studioModelSelection';
import type { KeyView } from '@/api/keys';

export type GuideStepId = 'signup' | 'topup' | 'key_page';

export interface GuideLinkStep {
  id: GuideStepId;
  label: string;
  url: string;
  /** 「?」里的一句话；没有就不显示「?」。 */
  hint?: string;
}

/** 推荐厂商的 presetId；与后端 onboarding_metrics.GuideVendor 同一枚举。 */
export type GuideVendor = 'tuzi' | 'tokendance';

export interface RecommendedProvider {
  presetId: GuideVendor;
  /** 卡片副行：覆盖哪些模型，一行状态字。 */
  coverage: string;
  steps: GuideLinkStep[];
  /** 最后一步「粘贴 Key」的「?」。 */
  pasteHint?: string;
}

// 飙哥 2026-11-17 定：兔子在前、TokenDance 在后。事实依据见 .scratch/key-onboarding/PLAN.md §5。
export const RECOMMENDED_PROVIDERS: readonly RecommendedProvider[] = [
  {
    presetId: 'tuzi',
    coverage: 'GPT Image · Nano Banana · Seedream · 视频',
    steps: [
      { id: 'signup', label: '注册', url: 'https://api.tu-zi.com/register', hint: '邮箱、GitHub 或 Google 均可' },
      { id: 'topup', label: '充值', url: 'https://api.tu-zi.com/console/topup', hint: '支付宝或微信，0.7 元 = 1 美元额度' },
      { id: 'key_page', label: '创建 Key', url: 'https://api.tu-zi.com/console/token', hint: '分组选 default，其他分组有价格倍率' },
    ],
    pasteHint: '在令牌列表点「复制」，粘贴到下一步的密钥框',
  },
  {
    presetId: 'tokendance',
    coverage: 'Seedream · 视频 · 语音',
    steps: [
      { id: 'signup', label: '注册', url: 'https://tokendance.space/login', hint: '需要观猹账号' },
      { id: 'topup', label: '充值', url: 'https://tokendance.space/credits', hint: '微信或支付宝，1 元起充' },
      { id: 'key_page', label: '创建 Key', url: 'https://tokendance.space/keys' },
    ],
  },
];

/** 「还没有可用模型」的唯一判据：没有一个已启用的供应商带图片或视频模型。 */
export function hasUsableModel(keys: readonly KeyView[]): boolean {
  return keys.some(key => key.enabled !== false
    && (modelsForKind(key, 'image').length > 0 || modelsForKind(key, 'video').length > 0));
}

/** 任何地方想打开引导，派发这个事件；AppShell 里的 OnboardingHost 负责弹出。 */
export const OPEN_ONBOARDING_EVENT = 'atelier:open-onboarding';
export type GuideSource = 'first_run' | 'model_chip' | 'providers';

export function openOnboarding(source: Exclude<GuideSource, 'first_run'>): void {
  window.dispatchEvent(new CustomEvent(OPEN_ONBOARDING_EVENT, { detail: { source } }));
}

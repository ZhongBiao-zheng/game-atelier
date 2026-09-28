import { modelModality, type KeyModel, type KeyView } from '@/api/keys';
import type { JobKind } from '@/schema/jobs';

/** 该 key 下属于这个生成类型的模型（模型级 modality 优先，key 级兜底；与 PromptInput 的过滤一致）。 */
export function modelsForKind(key: KeyView | undefined, kind: JobKind): KeyModel[] {
  const wanted = kind === 'video' ? 'video' : 'image';
  return (key?.models ?? []).filter((m) => modelModality(m, key) === wanted);
}

/**
 * 切换生成类型 / keys 加载后让 alias、model 落到本类模型上，保证「界面显示的 = 实际提交的」：
 * - 当前 key 没有本类模型 → 换到含当前模型的 key，否则第一个有本类模型的 key；
 * - model 属于另一类 → 换成该 key 本类第一个模型；
 * - model 为空（复刻时本机没有配方模型）→ 只收敛 alias，模型位留空等用户选；
 * - 本机不存在的 model id 原样保留，由 PromptInput 显示「选择模型」并禁用生成。
 * 返回 null 表示不用改。
 */
export function convergeModelSelection(
  keys: KeyView[],
  kind: JobKind,
  alias: string,
  model: string,
): { alias: string; model: string } | null {
  const current = keys.find((k) => k.alias === alias);
  const key = modelsForKind(current, kind).length > 0
    ? current
    : keys.find((k) => modelsForKind(k, kind).some((m) => m.id === model))
      ?? keys.find((k) => modelsForKind(k, kind).length > 0);
  if (!key) return null;
  const models = modelsForKind(key, kind);
  const otherKind = model !== '' && !models.some((m) => m.id === model)
    && keys.some((k) => (k.models ?? []).some((m) => m.id === model));
  const nextModel = otherKind ? models[0].id : model;
  if (key.alias === alias && nextModel === model) return null;
  return { alias: key.alias, model: nextModel };
}

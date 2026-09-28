import type { KeyView } from '@/api/keys';
import type { RoundConfig } from '@/components/studio/RoundList';
import type { GenerationRecipe, RecipeInput, RecipeInputRole } from '@/schema/creationAssets';
import type { Job, JobParams } from '@/schema/jobs';
import { configForJob } from './studioJobConfig';

export interface RecipeModelMatch { alias: string; model: string }

export interface RecipeDraft {
  config: RoundConfig;
  model: RecipeModelMatch | null;
  inputs: {
    images: RecipeInput[];
    videos: RecipeInput[];
    audios: RecipeInput[];
    mj: { sref: RecipeInput[]; cref: RecipeInput[]; oref: RecipeInput[] };
  };
}

const MASK_DROPPED_WARNING = '遮罩参考未带入';

/** 按模型 id 找本机 key（R8）：同 provider + 同 alias → 同 provider → 任意含该模型的 key。
 *  alias 是出图那台机器自己起的 key 名，只在 provider 也一致时才有参考意义。 */
export function resolveRecipeModel(recipe: GenerationRecipe, keys: KeyView[]): RecipeModelMatch | null {
  const candidates = keys.filter((key) => key.models.some((model) => model.id === recipe.model));
  const matched = candidates.find((key) => key.provider === recipe.provider && key.alias === recipe.alias)
    ?? candidates.find((key) => key.provider === recipe.provider)
    ?? candidates[0];
  return matched ? { alias: matched.alias, model: recipe.model } : null;
}

export function recipeToDraft(recipe: GenerationRecipe, keys: KeyView[]): RecipeDraft {
  const match = resolveRecipeModel(recipe, keys);
  const matchedKey = match ? keys.find((key) => key.alias === match.alias) : undefined;
  // 缺模型时 alias / provider 都置空：配方里的是出图那台机器的，本机没有对应 key。
  const base = configForJob(syntheticJob(recipe, match?.alias ?? null, matchedKey?.provider ?? null), keys);
  const hasMask = recipe.inputs.some((item) => item.role === 'mask');
  const config: RoundConfig = {
    ...base,
    referenceImages: [],
    ...(base.referenceVideos ? { referenceVideos: [] } : {}),
    ...(base.referenceAudios ? { referenceAudios: [] } : {}),
    ...(base.mjRefPaths ? { mjRefPaths: { sref: [], cref: [], oref: [] } } : {}),
    warnings: hasMask ? [...(base.warnings ?? []), MASK_DROPPED_WARNING] : base.warnings,
  };
  return {
    config,
    model: match,
    inputs: {
      images: inputsOf(recipe, 'reference', 'image'),
      videos: inputsOf(recipe, 'reference', 'video'),
      audios: inputsOf(recipe, 'reference', 'audio'),
      mj: {
        sref: inputsOf(recipe, 'mj_sref'),
        cref: inputsOf(recipe, 'mj_cref'),
        oref: inputsOf(recipe, 'mj_oref'),
      },
    },
  };
}

/** 只为复用 configForJob 的参数还原：从未落盘，job_id / 状态字段都是占位。 */
function syntheticJob(recipe: GenerationRecipe, alias: string | null, provider: string | null): Job {
  return {
    job_id: 'recipe',
    character_id: '',
    prompt: recipe.final_prompt,
    submitted_at: recipe.submitted_at,
    model: recipe.model,
    params: recipe.params as JobParams,
    output_paths: [],
    status: 'done',
    error: null,
    kind: recipe.mode,
    namespace: 'studio',
    alias,
    provider,
  };
}

function inputsOf(recipe: GenerationRecipe, role: RecipeInputRole, kind?: RecipeInput['kind']): RecipeInput[] {
  return recipe.inputs
    .filter((item) => item.role === role && (!kind || item.kind === kind))
    .sort((a, b) => a.order - b.order);
}

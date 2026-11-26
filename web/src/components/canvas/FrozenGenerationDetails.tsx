import type { CanvasFrozenGeneration } from '@/schema/canvas';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { formatGenerationCost } from '@/lib/generationCost';

const labels: Record<string, string> = {
  size: '尺寸', resolution: '分辨率', ratio: '比例', seed: '种子', mj_seed: '种子',
  duration: '时长', quality: '质量', n: '数量', frame_mode: '帧模式', generate_audio: '生成音频',
  temperature: '温度', max_tokens: '最大 Token 数', frame_count: '帧数', frame_duration_ms: '每帧毫秒',
  reference: '参考', source: '源图', mask: '蒙版', first_frame: '首帧', last_frame: '尾帧',
  markup: '标注', mj_sref: '风格参考', mj_oref: '全能参考', mj_cref: '角色参考',
};

export function FrozenGenerationDetails({ generation, mediaUrl }: {
  generation: CanvasFrozenGeneration; mediaUrl: (versionId: string) => string;
}) {
  const label = generation.provider_label || generation.provider;
  return <section aria-label="生成参数" className="space-y-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{generation.model_name || generation.model_id}</span>
      <ProviderBrandIcon size="sm" provider={{ provider: generation.provider, icon: generation.provider_icon, alias: label }} />
      <span>{label}</span>
    </div>
    {generation.prompt && <p className="whitespace-pre-wrap break-words">{generation.prompt}</p>}
    <dl className="grid gap-2 sm:grid-cols-2">
      {Object.entries(generation.params).map(([key, value]) => <div key={key}>
        <dt className="text-xs text-muted-foreground">{labels[key] || key}</dt>
        <dd className="break-words tabular-nums">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
      </div>)}
      {generation.duration_s != null && <div><dt>耗时</dt><dd>{generation.duration_s} 秒</dd></div>}
      {generation.cost_cny != null && <div><dt>费用</dt><dd>{formatGenerationCost(generation.cost_cny)}</dd></div>}
    </dl>
    {generation.inputs.length > 0 && <div className="flex flex-wrap gap-2">{generation.inputs.map(input =>
      <figure key={input.order} className="space-y-1">
        {input.kind === 'text' ? <p className="whitespace-pre-wrap">{input.text}</p> : input.version_id && (
          input.kind === 'image' ? <img src={mediaUrl(input.version_id)} alt={labels[input.role]} loading="lazy" className="size-16 rounded-md object-cover" />
            : input.kind === 'audio' ? <audio controls preload="none" src={mediaUrl(input.version_id)} />
            : <video controls preload="metadata" src={mediaUrl(input.version_id)} className="w-36 rounded-md" />
        )}
        <figcaption className="text-xs text-muted-foreground">{labels[input.role] || input.role} {input.order + 1}</figcaption>
      </figure>)}</div>}
  </section>;
}

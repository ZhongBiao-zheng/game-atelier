import { useRef, useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';

import {
  MJ_BOT_TYPES,
  MJ_CHAOS_STEPS,
  MJ_IW_STEPS,
  MJ_CW_STEPS,
  MJ_MODES,
  MJ_OW_STEPS,
  MJ_STYLIZE_STEPS,
  MJ_SW_STEPS,
  MJ_WEIRD_STEPS,
  mjSummary,
  normalizeVersion,
  versionsFor,
  type MjParams,
} from '@/lib/mjParams';
import { ToolbarPopover } from './ToolbarPopover';

interface Props {
  value: MjParams;
  onChange: (patch: Partial<MjParams>) => void;
  /** 哪几个参考槽有图 —— 权重控件只在对应槽上传后出现（没有图的权重毫无意义）。 */
  filledRefs?: { image?: boolean; sref?: boolean; cref?: boolean; oref?: boolean };
  menuDirection?: 'up' | 'down';
}

/** Midjourney 专属参数面板：收起态是一颗摘要按钮（v7 · 快速 · s100），点开是分区面板。
 *
 * 与视频侧的 VideoControls 同形（摘要按钮 + ToolbarPopover 分区），因为对画师是同一类东西：
 * 一组只在该模型下成立的生成参数。比例不在这里 —— 它是所有图像族共有的，留在尺寸控件里。
 */
export function MjControls({
  value,
  onChange,
  filledRefs = {},
  menuDirection = 'up',
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="Midjourney 参数"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          open ? 'border-border bg-secondary text-foreground' : 'border-border text-foreground hover:bg-secondary'
        }`}
      >
        <Sparkles size={14} aria-hidden />
        <span className="truncate">{mjSummary(value)}</span>
      </button>

      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        direction={menuDirection}
        data-testid="mj-settings-popover"
        className="w-[320px] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card p-3"
      >
        <div className="space-y-4">
          <Section title="模型">
            <div role="listbox" aria-label="选择 Midjourney 模型" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
              {MJ_BOT_TYPES.map((item) => (
                <SegmentButton
                  key={item.value}
                  selected={value.botType === item.value}
                  // 切模型要一起纠版本：两套体系的版本号不通用（--v 7 vs --niji 6），
                  // 留着旧值等于发一个不存在的组合。
                  onClick={() => onChange({
                    botType: item.value,
                    version: normalizeVersion(item.value, value.version),
                  })}
                >
                  {item.label}
                </SegmentButton>
              ))}
            </div>
          </Section>

          <Section
            title="版本"
            hint={value.botType === 'NIJI_JOURNEY' ? 'niji 自己的版本号，与 Midjourney 不通用' : undefined}
          >
            <select
              aria-label="选择版本"
              value={value.version}
              onChange={(e) => onChange({ version: e.target.value })}
              className="h-9 w-full rounded-lg border border-input bg-popover px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/60"
            >
              {versionsFor(value.botType).map((item) => (
                <option key={item} value={item}>
                  {value.botType === 'NIJI_JOURNEY' ? `niji ${item}` : `v${item}`}
                </option>
              ))}
            </select>
          </Section>

          <Section title="速度档">
            <div role="listbox" aria-label="选择速度档" className="grid h-9 grid-cols-3 rounded-lg bg-popover p-0.5">
              {MJ_MODES.map((item) => (
                <SegmentButton key={item.value} selected={value.mode === item.value} onClick={() => onChange({ mode: item.value })}>
                  {item.label}
                </SegmentButton>
              ))}
            </div>
          </Section>

          <Section title="风格化 stylize" hint="越高越有 MJ 自己的美术判断，越低越贴着 prompt">
            <div role="listbox" aria-label="选择风格化强度" className="grid grid-cols-6 gap-0.5 rounded-lg bg-popover p-0.5">
              {MJ_STYLIZE_STEPS.map((item) => (
                <SegmentButton key={item} selected={value.stylize === item} onClick={() => onChange({ stylize: item })}>
                  {item}
                </SegmentButton>
              ))}
            </div>
          </Section>

          {filledRefs.image && (
            <Section title="垫图权重 iw" hint="图片槽那张对结果的影响强度">
              <div role="listbox" aria-label="选择垫图权重" className="grid h-9 grid-cols-5 rounded-lg bg-popover p-0.5">
                <SegmentButton selected={value.iw === null} onClick={() => onChange({ iw: null })}>默认</SegmentButton>
                {MJ_IW_STEPS.map((item) => (
                  <SegmentButton key={item} selected={value.iw === item} onClick={() => onChange({ iw: item })}>
                    {item}
                  </SegmentButton>
                ))}
              </div>
            </Section>
          )}

          {filledRefs.sref && (
            <Section title="风格权重 sw" hint="风格参考图的影响强度（0-1000）">
              <div role="listbox" aria-label="选择风格权重" className="grid h-9 grid-cols-6 rounded-lg bg-popover p-0.5">
                <SegmentButton selected={value.sw === null} onClick={() => onChange({ sw: null })}>默认</SegmentButton>
                {MJ_SW_STEPS.map((item) => (
                  <SegmentButton key={item} selected={value.sw === item} onClick={() => onChange({ sw: item })}>
                    {item}
                  </SegmentButton>
                ))}
              </div>
            </Section>
          )}

          {filledRefs.cref && (
            <Section title="角色权重 cw" hint="角色参考图的影响强度（0-100）">
              <div role="listbox" aria-label="选择角色权重" className="grid h-9 grid-cols-5 rounded-lg bg-popover p-0.5">
                <SegmentButton selected={value.cw === null} onClick={() => onChange({ cw: null })}>默认</SegmentButton>
                {MJ_CW_STEPS.map((item) => (
                  <SegmentButton key={item} selected={value.cw === item} onClick={() => onChange({ cw: item })}>
                    {item}
                  </SegmentButton>
                ))}
              </div>
            </Section>
          )}

          {filledRefs.oref && (
            <Section title="Omni 权重 ow" hint="Omni 参考图的影响强度（0-1000）">
              <div role="listbox" aria-label="选择 Omni 权重" className="grid h-9 grid-cols-6 rounded-lg bg-popover p-0.5">
                <SegmentButton selected={value.ow === null} onClick={() => onChange({ ow: null })}>默认</SegmentButton>
                {MJ_OW_STEPS.map((item) => (
                  <SegmentButton key={item} selected={value.ow === item} onClick={() => onChange({ ow: item })}>
                    {item}
                  </SegmentButton>
                ))}
              </div>
            </Section>
          )}

          <Section title="混乱度 chaos" hint="越高，四张方案之间差异越大">
            <div role="listbox" aria-label="选择混乱度" className="grid grid-cols-5 gap-0.5 rounded-lg bg-popover p-0.5">
              {MJ_CHAOS_STEPS.map((item) => (
                <SegmentButton key={item} selected={value.chaos === item} onClick={() => onChange({ chaos: item })}>
                  {item}
                </SegmentButton>
              ))}
            </div>
          </Section>

          <Section title="排除词 no" hint="不想出现的东西，逗号分隔">
            <input
              type="text"
              value={value.no}
              onChange={(e) => onChange({ no: e.target.value })}
              placeholder="text, watermark, blur"
              aria-label="排除词"
              className="h-9 w-full rounded-lg border border-input bg-popover px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </Section>

          <Section title="种子 seed" hint="填同一个种子 + 同一条 prompt 可复现构图">
            <input
              type="text"
              inputMode="numeric"
              value={value.seed}
              onChange={(e) => onChange({ seed: e.target.value.replace(/[^0-9]/g, '') })}
              placeholder="留空 = 随机"
              aria-label="种子"
              className="h-9 w-full rounded-lg border border-input bg-popover px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </Section>

          <Section title="怪异度 weird" hint="往非常规审美偏，和 stylize 是两个方向">
            <div role="listbox" aria-label="选择怪异度" className="grid h-9 grid-cols-4 rounded-lg bg-popover p-0.5">
              {MJ_WEIRD_STEPS.map((item) => (
                <SegmentButton key={item} selected={value.weird === item} onClick={() => onChange({ weird: item })}>
                  {item}
                </SegmentButton>
              ))}
            </div>
          </Section>

          <Section title="无缝平铺 tile" hint="出可四方连续的贴图">
            <div role="listbox" aria-label="无缝平铺开关" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
              <SegmentButton selected={value.tile} onClick={() => onChange({ tile: true })}>开启</SegmentButton>
              <SegmentButton selected={!value.tile} onClick={() => onChange({ tile: false })}>关闭</SegmentButton>
            </div>
          </Section>
        </div>
      </ToolbarPopover>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="w-[296px]">
      <div className="py-1 px-1 text-xs text-muted-foreground">{title}</div>
      {hint && <div className="px-1 pb-1 text-xs text-muted-foreground/70">{hint}</div>}
      {children}
    </section>
  );
}

function SegmentButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className="h-8 rounded-md text-center text-xs hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
    >
      {children}
    </button>
  );
}

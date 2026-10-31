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
  normalizeProfileInput,
  normalizeVersion,
  tileSupported,
  versionsFor,
  type MjParams,
} from '@/lib/mjParams';
import { ToolbarPopover } from './ToolbarPopover';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';

interface Props {
  value: MjParams;
  onChange: (patch: Partial<MjParams>) => void;
  /** 哪几个参考槽有图 —— 权重控件只在对应槽上传后出现（没有图的权重毫无意义）。 */
  filledRefs?: { image?: boolean; sref?: boolean; cref?: boolean; oref?: boolean };
  menuDirection?: 'up' | 'down';
  evolink?: boolean;
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
  evolink = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <Button variant="bare"
        type="button"
        aria-label="Midjourney 参数"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          open ? 'border-border bg-secondary text-foreground' : 'border-border text-foreground hover:bg-secondary'
        }`}
      >
        <Sparkles size={14} aria-hidden />
        <span className="truncate">{evolink ? 'Fast · Standard' : mjSummary(value)}</span>
      </Button>

      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        direction={menuDirection}
        data-testid="mj-settings-popover"
        className="w-[320px] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card p-3"
      >
        <div className="space-y-4">
          {!evolink && <Section title="模型">
            <Segmented aria-label="选择 Midjourney 模型" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
              {MJ_BOT_TYPES.map((item) => (
                <SegmentedItem key={item.value} value={String(item.value)} selected={value.botType === item.value} onSelect={() => onChange(withTileGate({
                    botType: item.value,
                    version: normalizeVersion(item.value, value.version),
                  }, value))} className="text-xs">
                  {item.label}
                </SegmentedItem>
              ))}
            </Segmented>
          </Section>}

          {!evolink && <Section
            title="版本"
            hint={value.botType === 'NIJI_JOURNEY' ? 'niji 自己的版本号，与 Midjourney 不通用' : undefined}
          >
            <Select
              value={value.version}
              onValueChange={(version) => onChange(withTileGate({ version }, value))}
            >
              <SelectTrigger aria-label="选择版本"><SelectValue /></SelectTrigger>
              <SelectContent>
                {versionsFor(value.botType).map((item) => (
                  <SelectItem key={item} value={item}>
                    {value.botType === 'NIJI_JOURNEY' ? `niji ${item}` : `v${item}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Section>}

          {!evolink && <Section title="速度档">
            <Segmented aria-label="选择速度档" className="grid h-9 grid-cols-3 rounded-lg bg-popover p-0.5">
              {MJ_MODES.map((item) => (
                <SegmentedItem key={item.value} value={String(item.value)} selected={value.mode === item.value} onSelect={() => onChange({ mode: item.value })} className="text-xs">
                  {item.label}
                </SegmentedItem>
              ))}
            </Segmented>
          </Section>}

          <Section title="风格化 stylize" hint="越高越有 MJ 自己的美术判断，越低越贴着 prompt">
            <Segmented aria-label="选择风格化强度" className="grid grid-cols-6 gap-0.5 rounded-lg bg-popover p-0.5">
              {MJ_STYLIZE_STEPS.map((item) => (
                <SegmentedItem key={item} value={String(item)} selected={value.stylize === item} onSelect={() => onChange({ stylize: item })} className="text-xs">
                  {item}
                </SegmentedItem>
              ))}
            </Segmented>
          </Section>

          {filledRefs.image && (
            <Section title="垫图权重 iw" hint="图片槽那张对结果的影响强度">
              <Segmented aria-label="选择垫图权重" className="grid h-9 grid-cols-5 rounded-lg bg-popover p-0.5">
                <SegmentedItem selected={value.iw === null} onSelect={() => onChange({ iw: null })} value="默认" className="text-xs">默认</SegmentedItem>
                {MJ_IW_STEPS.map((item) => (
                  <SegmentedItem key={item} value={String(item)} selected={value.iw === item} onSelect={() => onChange({ iw: item })} className="text-xs">
                    {item}
                  </SegmentedItem>
                ))}
              </Segmented>
            </Section>
          )}

          {filledRefs.sref && (
            <Section title="风格权重 sw" hint="风格参考图的影响强度（0-1000）">
              <Segmented aria-label="选择风格权重" className="grid h-9 grid-cols-6 rounded-lg bg-popover p-0.5">
                <SegmentedItem selected={value.sw === null} onSelect={() => onChange({ sw: null })} value="默认" className="text-xs">默认</SegmentedItem>
                {MJ_SW_STEPS.map((item) => (
                  <SegmentedItem key={item} value={String(item)} selected={value.sw === item} onSelect={() => onChange({ sw: item })} className="text-xs">
                    {item}
                  </SegmentedItem>
                ))}
              </Segmented>
            </Section>
          )}

          {!evolink && filledRefs.cref && (
            <Section title="角色权重 cw" hint="角色参考图的影响强度（0-100）">
              <Segmented aria-label="选择角色权重" className="grid h-9 grid-cols-5 rounded-lg bg-popover p-0.5">
                <SegmentedItem selected={value.cw === null} onSelect={() => onChange({ cw: null })} value="默认" className="text-xs">默认</SegmentedItem>
                {MJ_CW_STEPS.map((item) => (
                  <SegmentedItem key={item} value={String(item)} selected={value.cw === item} onSelect={() => onChange({ cw: item })} className="text-xs">
                    {item}
                  </SegmentedItem>
                ))}
              </Segmented>
            </Section>
          )}

          {!evolink && filledRefs.oref && (
            <Section title="Omni 权重 ow" hint="Omni 参考图的影响强度（0-1000）">
              <Segmented aria-label="选择 Omni 权重" className="grid h-9 grid-cols-6 rounded-lg bg-popover p-0.5">
                <SegmentedItem selected={value.ow === null} onSelect={() => onChange({ ow: null })} value="默认" className="text-xs">默认</SegmentedItem>
                {MJ_OW_STEPS.map((item) => (
                  <SegmentedItem key={item} value={String(item)} selected={value.ow === item} onSelect={() => onChange({ ow: item })} className="text-xs">
                    {item}
                  </SegmentedItem>
                ))}
              </Segmented>
            </Section>
          )}

          <Section title="混乱度 chaos" hint="越高，四张方案之间差异越大">
            <Segmented aria-label="选择混乱度" className="grid grid-cols-5 gap-0.5 rounded-lg bg-popover p-0.5">
              {MJ_CHAOS_STEPS.map((item) => (
                <SegmentedItem key={item} value={String(item)} selected={value.chaos === item} onSelect={() => onChange({ chaos: item })} className="text-xs">
                  {item}
                </SegmentedItem>
              ))}
            </Segmented>
          </Section>

          <Section title="风格编号 sref" hint="只填数字；填写后会暂停使用上传的风格参考图">
            <Input
              type="text"
              inputMode="numeric"
              maxLength={32}
              value={value.srefCode}
              onChange={(e) => onChange({ srefCode: e.target.value.replace(/[^0-9]/g, '') })}
              placeholder="例如 1967932137"
              aria-label="sref 编号"
              className="w-full"
            />
          </Section>

          {!evolink && <Section title="个性化 profile" hint="填写 Midjourney Profile code 或 ID">
            <Input
              type="text"
              value={value.profile}
              onChange={(e) => {
                const profile = normalizeProfileInput(e.target.value);
                if (profile !== null) onChange({ profile });
              }}
              placeholder="例如 e6wl24r"
              aria-label="profile"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full"
            />
          </Section>}

          <Section title="排除词 no" hint="不想出现的东西，逗号分隔">
            <Input
              type="text"
              value={value.no}
              onChange={(e) => onChange({ no: e.target.value })}
              placeholder="text, watermark, blur"
              aria-label="排除词"
              className="w-full"
            />
          </Section>

          <Section title="种子 seed" hint="填同一个种子 + 同一条 prompt 可复现构图">
            <Input
              type="text"
              inputMode="numeric"
              value={value.seed}
              onChange={(e) => onChange({ seed: e.target.value.replace(/[^0-9]/g, '') })}
              placeholder="留空 = 随机"
              aria-label="种子"
              className="w-full"
            />
          </Section>

          <Section title="怪异度 weird" hint="往非常规审美偏，和 stylize 是两个方向">
            <Segmented aria-label="选择怪异度" className="grid h-9 grid-cols-4 rounded-lg bg-popover p-0.5">
              {MJ_WEIRD_STEPS.map((item) => (
                <SegmentedItem key={item} value={String(item)} selected={value.weird === item} onSelect={() => onChange({ weird: item })} className="text-xs">
                  {item}
                </SegmentedItem>
              ))}
            </Segmented>
          </Section>

          {tileSupported(value.botType, value.version) && (
            <Section title="无缝平铺 tile" hint="出可四方连续的贴图">
              <Segmented aria-label="无缝平铺开关" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                <SegmentedItem selected={value.tile} onSelect={() => onChange({ tile: true })} value="开启" className="text-xs">开启</SegmentedItem>
                <SegmentedItem selected={!value.tile} onSelect={() => onChange({ tile: false })} value="关闭" className="text-xs">关闭</SegmentedItem>
              </Segmented>
            </Section>
          )}
        </div>
      </ToolbarPopover>
    </div>
  );
}

/** 换模型 / 换版本时，如果新组合不支持 tile 就把它一起关掉：控件会随之收起，留着
 *  tile=true 等于攒一个到提交时才被后端摘掉的死开关。 */
function withTileGate(patch: Partial<MjParams>, current: MjParams): Partial<MjParams> {
  const botType = patch.botType ?? current.botType;
  const version = patch.version ?? current.version;
  return tileSupported(botType, version) ? patch : { ...patch, tile: false };
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="w-[296px]">
      <div className="py-1 px-1 text-xs text-muted-foreground">{title}</div>
      {hint && <div className="px-1 pb-1 text-xs text-muted-foreground">{hint}</div>}
      {children}
    </section>
  );
}

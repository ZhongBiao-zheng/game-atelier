import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Search, ChevronDown, Image as ImageIcon, Video, Wand2, Heart, EyeOff, Check, X } from 'lucide-react';

import { ToolbarPopover } from './ToolbarPopover';
import type { GenMode, HistoryFilters, TimeFilter } from '@/lib/historyFilters';

const TIME_OPTS: { key: TimeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: '1w', label: '最近一周' },
  { key: '1m', label: '最近一个月' },
  { key: '3m', label: '最近三个月' },
];
const MODE_OPTS: { key: GenMode; label: string; icon: ReactNode }[] = [
  { key: 'image', label: '图片', icon: <ImageIcon size={18} aria-hidden /> },
  { key: 'video', label: '视频', icon: <Video size={18} aria-hidden /> },
  { key: 'skill', label: 'Skill', icon: <Wand2 size={18} aria-hidden /> },
];
const OP_OPTS: { key: 'favorite' | 'hidden'; label: string; icon: ReactNode }[] = [
  { key: 'favorite', label: '喜欢', icon: <Heart size={18} aria-hidden /> },
  { key: 'hidden', label: '隐藏', icon: <EyeOff size={18} aria-hidden /> },
];

/** 查询面板 chip——复用 PromptInput ControlButton 配方（h-7 rounded-md token 色）。 */
function FilterChip({
  active,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active ? 'bg-secondary text-foreground' : 'text-foreground hover:bg-secondary'
      }`}
      {...props}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

export function StudioQueryBar({
  filters,
  onChange,
}: {
  filters: HistoryFilters;
  onChange: (next: HistoryFilters) => void;
}) {
  const [openPanel, setOpenPanel] = useState<'time' | 'mode' | 'op' | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);
  const opRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const toggle = (panel: 'time' | 'mode' | 'op') => setOpenPanel((p) => (p === panel ? null : panel));
  const panelCls = 'w-60 rounded-xl border border-border bg-card p-2';
  const optionCls =
    'flex h-10 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary/60';

  return (
    <div
      data-testid="studio-query-bar"
      className="pointer-events-auto inline-flex h-9 items-center rounded-full border border-input bg-glass px-1.5 backdrop-blur-glass"
    >
      {/* 搜索区常驻挂载，靠宽度过渡做展开/收起滑动动画（条件渲染会瞬间跳变）。 */}
      <div
        className={`flex items-center overflow-hidden transition-[width] duration-300 ease-out ${
          searchOpen ? 'w-80 pr-2' : 'w-8'
        }`}
      >
        <button
          type="button"
          aria-label="搜索"
          onClick={() => (searchOpen ? searchInputRef.current?.focus() : setSearchOpen(true))}
          className="grid size-8 shrink-0 place-items-center rounded-full text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Search size={16} aria-hidden />
        </button>
        <input
          ref={searchInputRef}
          value={filters.search}
          placeholder="搜索提示词…"
          aria-label="按提示词搜索出图记录"
          tabIndex={searchOpen ? 0 : -1}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          onBlur={() => { if (!filters.search) setSearchOpen(false); }}
          className={`h-7 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none transition-opacity duration-200 ${
            searchOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        />
        <button
          type="button"
          aria-label="关闭搜索"
          tabIndex={searchOpen ? 0 : -1}
          onClick={() => { onChange({ ...filters, search: '' }); setSearchOpen(false); }}
          className={`grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary transition-opacity duration-200 ${
            searchOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <Divider />
      <div ref={timeRef} className="relative">
        <FilterChip active={openPanel === 'time'} aria-label="时间筛选" onClick={() => toggle('time')}>
          时间 <ChevronDown size={14} aria-hidden className="text-muted-foreground" />
        </FilterChip>
        <ToolbarPopover open={openPanel === 'time'} onClose={() => setOpenPanel(null)} anchorRef={timeRef} direction="down" role="listbox" aria-label="时间筛选列表" className={panelCls}>
          {TIME_OPTS.map((o) => (
            <button key={o.key} type="button" role="option" aria-selected={filters.time === o.key} className={optionCls}
              onClick={() => onChange({ ...filters, time: o.key })}>
              <span>{o.label}</span>
              {filters.time === o.key && <Check size={16} aria-hidden className="text-primary" />}
            </button>
          ))}
        </ToolbarPopover>
      </div>

      <Divider />
      <div ref={modeRef} className="relative">
        <FilterChip active={openPanel === 'mode'} aria-label="生成模式筛选" onClick={() => toggle('mode')}>
          生成模式 <ChevronDown size={14} aria-hidden className="text-muted-foreground" />
        </FilterChip>
        <ToolbarPopover open={openPanel === 'mode'} onClose={() => setOpenPanel(null)} anchorRef={modeRef} direction="down" role="listbox" aria-label="生成模式列表" aria-multiselectable="true" className={panelCls}>
          <div className="px-3 py-2 text-sm text-muted-foreground">生成模式</div>
          {MODE_OPTS.map((o) => {
            const active = filters.modes.includes(o.key);
            return (
              <button key={o.key} type="button" role="option" aria-selected={active} className={optionCls}
                onClick={() => onChange({
                  ...filters,
                  modes: active
                    ? filters.modes.filter((mode) => mode !== o.key)
                    : [...filters.modes, o.key],
                })}>
                <span className="flex items-center gap-3">{o.icon}{o.label}</span>
                {active && <Check size={16} aria-hidden className="text-primary" />}
              </button>
            );
          })}
        </ToolbarPopover>
      </div>

      <Divider />
      <div ref={opRef} className="relative">
        <FilterChip active={openPanel === 'op'} aria-label="操作类型筛选" onClick={() => toggle('op')}>
          操作类型 <ChevronDown size={14} aria-hidden className="text-muted-foreground" />
        </FilterChip>
        <ToolbarPopover open={openPanel === 'op'} onClose={() => setOpenPanel(null)} anchorRef={opRef} direction="down" role="listbox" aria-label="操作类型列表" className={panelCls}>
          <div className="px-3 py-2 text-sm text-muted-foreground">操作</div>
          {OP_OPTS.map((o) => {
            const active = filters.op === o.key;
            return (
              <button key={o.key} type="button" role="option" aria-selected={active} className={optionCls}
                onClick={() => onChange({ ...filters, op: active ? null : o.key })}>
                <span className="flex items-center gap-3">{o.icon}{o.label}</span>
                {active && <Check size={16} aria-hidden className="text-primary" />}
              </button>
            );
          })}
        </ToolbarPopover>
      </div>
    </div>
  );
}

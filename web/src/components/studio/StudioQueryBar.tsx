import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AiIcon, ChevronDownIcon, CloseIcon, FavoriteIcon, HideIcon, ImageIcon, SearchIcon, VideoIcon } from '@/components/ui/icons';

import { ToolbarPopover } from './ToolbarPopover';
import { DEFAULT_HISTORY_FILTERS, type GenMode, type HistoryFilters, type TimeFilter } from '@/lib/historyFilters';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const TIME_OPTS: { key: TimeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: '1w', label: '最近一周' },
  { key: '1m', label: '最近一个月' },
  { key: '3m', label: '最近三个月' },
];
const MODE_OPTS: { key: GenMode; label: string; icon: ReactNode }[] = [
  { key: 'agent', label: 'Agent', icon: <AiIcon size="sm" aria-hidden /> },
  { key: 'image', label: '图片', icon: <ImageIcon size="sm" aria-hidden /> },
  { key: 'video', label: '视频', icon: <VideoIcon size="sm" aria-hidden /> },
];
const OP_OPTS: { key: 'favorite' | 'hidden'; label: string; icon: ReactNode }[] = [
  { key: 'favorite', label: '喜欢', icon: <FavoriteIcon size="sm" aria-hidden /> },
  { key: 'hidden', label: '隐藏', icon: <HideIcon size="sm" aria-hidden /> },
];

/** 查询面板 chip——复用 PromptInput ControlButton 配方（h-7 rounded-md token 色）。 */
function FilterChip({
  active,
  filtered,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; filtered?: boolean }) {
  return (
    <Button variant="bare"
      type="button"
      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 sm:px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active ? 'bg-secondary' : 'hover:bg-secondary'
      } ${filtered ? 'text-primary' : 'text-foreground'}`}
      {...props}
    >
      {children}
    </Button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 sm:mx-1 h-4 w-px shrink-0 bg-border" />;
}

export function StudioQueryBar({
  filters,
  onChange,
}: {
  filters: HistoryFilters;
  onChange: (next: HistoryFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const optionCls =
    'flex h-8 w-full items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground aria-selected:bg-secondary aria-selected:text-foreground aria-selected:ring-1 aria-selected:ring-inset aria-selected:ring-primary/60';
  const timeLabel = filters.time === 'all' ? '' : TIME_OPTS.find(option => option.key === filters.time)?.label;
  const modeLabel = MODE_OPTS.filter(option => filters.modes.includes(option.key)).map(option => option.label).join('、');
  const opLabel = OP_OPTS.find(option => option.key === filters.op)?.label;
  const summary = [timeLabel, modeLabel, opLabel].filter(Boolean);
  const sectionCls = 'mb-1.5 text-xs text-muted-foreground';

  return (
    <div
      data-testid="studio-query-bar"
      className="pointer-events-auto inline-flex min-w-0 max-w-full shrink-0 h-9 items-center rounded-full border border-input bg-glass px-1.5 backdrop-blur-glass"
    >
      {/* 搜索区常驻挂载，靠宽度过渡做展开/收起滑动动画（条件渲染会瞬间跳变）。 */}
      <div
        // 展开 300ms out；收起是退场，150ms subtle（默认曲线）。
        className={`flex items-center overflow-hidden transition-[width] ${
          searchOpen ? 'w-24 md:w-48 lg:w-80 pr-1 duration-300 ease-out' : 'w-8 duration-150'
        }`}
      >
        <Button variant="bare"
          type="button"
          aria-label="搜索"
          onClick={() => (searchOpen ? searchInputRef.current?.focus() : setSearchOpen(true))}
          className={`grid size-8 shrink-0 place-items-center rounded-full text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${searchOpen ? 'max-sm:hidden' : ''}`}
        >
          <SearchIcon aria-hidden />
        </Button>
        <Input variant="bare"
          ref={searchInputRef}
          value={filters.search}
          placeholder="搜索提示词…"
          aria-label="按提示词搜索出图记录"
          tabIndex={searchOpen ? 0 : -1}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          onBlur={() => { if (!filters.search) setSearchOpen(false); }}
          className={`h-7 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none transition-opacity duration-150 ${
            searchOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        />
        <Button variant="bare"
          type="button"
          aria-label="关闭搜索"
          tabIndex={searchOpen ? 0 : -1}
          onClick={() => { onChange({ ...filters, search: '' }); setSearchOpen(false); }}
          className={`grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary transition-[opacity,background-color] duration-150 ${
            searchOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <CloseIcon size="sm" aria-hidden />
        </Button>
      </div>

      <Divider />
      <div ref={anchorRef} className="relative">
        <FilterChip active={open} filtered={summary.length > 0} aria-expanded={open}
          aria-label={`筛选${summary.length ? `：${summary.join('，')}` : ''}`} onClick={() => setOpen(!open)}>
          筛选{summary.length > 0 && <span className="tabular-nums">{summary.length}</span>}
          <ChevronDownIcon size="sm" aria-hidden className={summary.length ? 'text-primary' : 'text-muted-foreground'} />
        </FilterChip>
        <ToolbarPopover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} direction="down" align="end" aria-label="筛选面板"
          className="flex w-72 flex-col gap-3.5 rounded-xl border border-border bg-card p-3.5" maxHeight={480}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">筛选</span>
            {summary.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => onChange({ ...DEFAULT_HISTORY_FILTERS, search: filters.search })}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                重置
              </Button>
            )}
          </div>
          <div>
            <div className={sectionCls}>时间</div>
            <div role="listbox" aria-label="时间筛选列表" className="grid grid-cols-2 gap-1 rounded-lg bg-popover p-1">
              {TIME_OPTS.map((o) => (
                <Button variant="bare" key={o.key} type="button" role="option" aria-selected={filters.time === o.key} className={optionCls}
                  onClick={() => onChange({ ...filters, time: o.key })}>
                  <span>{o.label}</span>
                </Button>
              ))}
            </div>
          </div>
          <div>
            <div className={sectionCls}>生成模式</div>
            <div role="listbox" aria-label="生成模式列表" aria-multiselectable="true" className="grid grid-cols-3 gap-1 rounded-lg bg-popover p-1">
              {MODE_OPTS.map((o) => {
                const active = filters.modes.includes(o.key);
                return (
                  <Button variant="bare" key={o.key} type="button" role="option" aria-selected={active} className={optionCls}
                    onClick={() => onChange({
                      ...filters,
                      modes: active
                        ? filters.modes.filter((mode) => mode !== o.key)
                        : [...filters.modes, o.key],
                    })}>
                    {o.icon}<span>{o.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
          <div>
            <div className={sectionCls}>操作类型</div>
            <div role="listbox" aria-label="操作类型列表" className="grid grid-cols-2 gap-1 rounded-lg bg-popover p-1">
              {OP_OPTS.map((o) => {
                const active = filters.op === o.key;
                return (
                  <Button variant="bare" key={o.key} type="button" role="option" aria-selected={active} className={optionCls}
                    onClick={() => onChange({ ...filters, op: active ? null : o.key })}>
                    {o.icon}<span>{o.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </ToolbarPopover>
      </div>
    </div>
  );
}

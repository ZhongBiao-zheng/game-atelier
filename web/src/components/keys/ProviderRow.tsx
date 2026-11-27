import { useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { CheckIcon, ChevronRightIcon } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { providerLabel } from '@/lib/providerLabels';
import type { ComfyStatus } from '@/lib/useComfyStatus';
import type { KeyRow } from './KeyCard';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  MOTION_DURATION,
  MOTION_EASE,
  MOTION_SPRING,
  motionAvailable,
  prefersReducedMotion,
  shakeOnError,
  useAnimateOnChange,
} from '@/lib/motion';

export function providerHost(row: KeyRow) {
  try { return new URL(row.base_url || row.homepage_url || '').host; }
  catch { return ''; }
}

export function ProviderRow({ row, overdue, pending, saved = false, failedTick = 0, animateHeight = false, comfyStatus, onEdit, onToggle }: {
  row: KeyRow; overdue: boolean; pending: boolean; saved?: boolean;
  /** 启停保存失败回滚时递增：只在触发失败的开关上局部微抖 250ms。 */
  failedTick?: number;
  /** 新增或删除行时启用高度展开/收起；高频搜索筛选时关掉，保持瞬切。 */
  animateHeight?: boolean;
  comfyStatus?: ComfyStatus;
  onEdit: () => void; onToggle: (enabled: boolean) => void;
}) {
  const switchWrapRef = useRef<HTMLSpanElement>(null);
  useAnimateOnChange(failedTick, next => {
    if (next > 0) shakeOnError(switchWrapRef.current);
  });

  const enabled = row.enabled !== false;
  const elapsed = row.last_used_at ? Math.max(0, Date.now() - Date.parse(row.last_used_at)) : null;
  const days = elapsed === null ? null : Math.floor(elapsed / 86400000);
  const idle = elapsed !== null && elapsed > 30 * 86400000;
  const comfyLive = row.provider === 'comfyui' && enabled && !overdue ? comfyStatus : undefined;
  const status = !enabled ? '已停用' : overdue ? '欠费'
    : comfyLive === 'running' ? '运行中'
      : comfyLive === 'stopped' ? '未启动'
        : comfyLive === 'checking' ? '检查中…'
          : days === null ? '未用过' : idle ? `${days} 天未用` : '正常';
  const vendor = providerLabel(row.provider, row.alias);
  const tone = !enabled ? 'text-muted-foreground' : overdue ? 'text-[color:var(--status-failed)]'
    : comfyLive === 'running' ? 'text-[color:var(--status-done)]'
      : comfyLive === 'stopped' ? 'text-[color:var(--status-failed)]'
        : comfyLive === 'checking' ? 'text-muted-foreground'
          : days === null || idle ? 'text-muted-foreground' : 'text-[color:var(--status-done)]';
  const used = row.last_used_at ? new Date(row.last_used_at) : null;
  const today = used?.toDateString() === new Date().toDateString();
  const title = row.provider === 'chatgpt' ? vendor : row.alias;
  const rawType = row.provider === 'custom' ? '自定义' : vendor;
  const showType = rawType.trim().toLowerCase() !== title.trim().toLowerCase();
  const host = providerHost(row);

  const canAnimate = animateHeight && motionAvailable();
  const reduced = prefersReducedMotion();

  // 启停是乐观的：外层 li 保留 opacity-50 语义与高度动画，内层承接进退场淡入淡出，不互相覆盖。
  return (
    <motion.li
      aria-busy={pending || undefined}
      initial={canAnimate ? (reduced ? { opacity: 0 } : { height: 0 }) : false}
      animate={canAnimate ? (reduced ? { opacity: 1 } : { height: 'auto' }) : undefined}
      exit={canAnimate ? (reduced ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }
        : { height: 0, transition: { duration: MOTION_DURATION.base, ease: MOTION_EASE.inOut } }) : undefined}
      transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE.out }}
      className={`group/row overflow-hidden transition-[opacity,background-color] duration-200 hover:bg-secondary/40 ${saved ? 'bg-primary/5' : ''} ${enabled ? '' : 'opacity-50 hover:opacity-80'}`}
    >
      <motion.div
        initial={canAnimate ? (reduced ? { opacity: 0 } : { opacity: 0, y: -4 }) : false}
        animate={canAnimate ? { opacity: 1, y: 0 } : undefined}
        exit={canAnimate ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } } : undefined}
        transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE.out }}
        className="flex flex-wrap items-center gap-3 px-4 py-3"
      >
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary/50 text-xs font-medium transition-colors duration-150 group-hover/row:bg-secondary/80">
          <ProviderBrandIcon size="md" provider={row} />
        </span>
        <Button variant="bare" type="button" aria-label={`编辑 ${row.alias}`} onClick={onEdit}
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="truncate">{title}</span>
            <AnimatePresence>
              {saved && (
                <motion.span
                  key="saved"
                  initial={motionAvailable() ? (reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5 }) : false}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.75 }}
                  transition={reduced
                    ? { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }
                    : { ...MOTION_SPRING.pop, opacity: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }}
                  className="inline-flex shrink-0 items-center"
                >
                  <CheckIcon size="sm" role="img" aria-label="已保存" className="text-[color:var(--status-done)]" />
                </motion.span>
              )}
            </AnimatePresence>
          </span>
          <Hint label={row.base_url ?? ''}><span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {[showType ? rawType : '', host, `${row.models?.length ?? 0} 个${row.provider === 'comfyui' ? '工作流' : '模型'}`].filter(Boolean).join(' · ')}
          </span></Hint>
        </Button>
        <div className="order-last flex w-full items-center justify-between gap-3 pl-11 text-xs sm:order-none sm:w-auto sm:pl-0">
          <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
            <span aria-hidden className={`size-1.5 rounded-full bg-current transition-colors duration-150 ${tone}`} />
            <span key={status} className="content-swap-in">{status}</span>
          </span>
          <Hint label={used?.toLocaleString('zh-CN')}><span className="whitespace-nowrap text-right tabular-nums text-muted-foreground sm:w-24">
            {!used ? '—' : today ? `今天 ${used.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
              : used.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
          </span></Hint>
        </div>
        <span ref={switchWrapRef} className="inline-flex">
          <Switch size="sm" checked={enabled} aria-label={`启用 ${row.alias}`} onCheckedChange={onToggle} />
        </span>
        <Button variant="bare" type="button" aria-label={`打开 ${row.alias}`} onClick={onEdit}
          className="rounded-md p-1 text-muted-foreground transition-colors duration-150 group-hover/row:text-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <ChevronRightIcon size="sm" className="transition-transform duration-150 motion-safe:group-hover/row:translate-x-0.5" aria-hidden />
        </Button>
      </motion.div>
    </motion.li>
  );
}

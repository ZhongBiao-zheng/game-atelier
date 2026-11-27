import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AddIcon, CloseIcon, SearchIcon } from '@/components/ui/icons';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { getChatGPTSubscription, type ChatGPTSubscriptionStatus } from '@/api/keys';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { errorText } from '@/lib/errorText';
import {
  MOTION_DURATION,
  MOTION_EASE,
  MOTION_SPRING,
  motionAvailable,
  prefersReducedMotion,
} from '@/lib/motion';
import { PROVIDER_PRESETS, providerPresetId, type ProviderPreset } from './providerPresets';

const GROUPS = [
  { kind: 'official', title: '供应商', description: '模型厂商官方接口' },
  { kind: 'relay', title: '中转', description: '一个密钥，多家模型' },
  { kind: 'subscription', title: '订阅', description: '登录即可，无需密钥' },
  { kind: 'local', title: '本机', description: '连接本机运行的服务' },
  { kind: 'team', title: '团队网关', description: '连接同事开启的团队网关' },
] as const;

const MODALITIES: Record<string, string> = { image: '图片', video: '视频', audio: '音频', llm: '文本' };
const CUSTOM_PRESET = PROVIDER_PRESETS.find(preset => preset.id === 'custom')!;
/** 订阅探测超过这么久才显示「加载中…」：本机毫秒级返回时不闪一下占位字。 */
const SUBSCRIPTION_LOADING_DELAY_MS = 200;

function presetHint(preset: ProviderPreset): string {
  if (preset.value === 'atelier') return '模型由对方决定';
  if (preset.id === 'evolink') return 'Midjourney';
  return preset.modalities.map(modality => MODALITIES[modality] ?? modality).join(' · ');
}

export interface ProviderCatalogSectionProps {
  /** 已配置的全部供应商（含已启用与已关闭），用于隐藏下方已配置的预置项。 */
  keys: { provider?: string; base_url?: string | null }[];
  onSelect: (preset: ProviderPreset) => void;
}

export function ProviderCatalogSection({ keys, onSelect }: ProviderCatalogSectionProps) {
  const [query, setQuery] = useState('');
  const [catalogMotion, setCatalogMotion] = useState<'reveal' | 'instant'>('reveal');
  const [subscription, setSubscription] = useState<ChatGPTSubscriptionStatus | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [showSubLoading, setShowSubLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const configuredIds = useMemo(
    () => new Set(keys.map(key => providerPresetId(key)).filter(id => id !== 'custom')),
    [keys],
  );
  const showChatGPT = !configuredIds.has('chatgpt');

  // 仅当已配置列表变化时开启补位动效；搜索打字切回 instant，避免逐字输入时卡片乱飘。
  const keysSignature = useMemo(
    () => Array.from(configuredIds).sort().join(','),
    [configuredIds],
  );
  const prevSignature = useRef(keysSignature);
  if (prevSignature.current !== keysSignature) {
    prevSignature.current = keysSignature;
    if (catalogMotion !== 'reveal') setCatalogMotion('reveal');
  }

  useEffect(() => {
    if (!showChatGPT) return;
    let active = true;
    setShowSubLoading(false);
    const delay = window.setTimeout(() => { if (active) setShowSubLoading(true); }, SUBSCRIPTION_LOADING_DELAY_MS);
    void getChatGPTSubscription()
      .then(data => { if (active) { window.clearTimeout(delay); setSubscription(data); } })
      .catch(error => { if (active) { window.clearTimeout(delay); setSubscriptionError(errorText(error)); } });
    return () => { active = false; window.clearTimeout(delay); };
  }, [showChatGPT]);

  const remaining = useMemo(
    () => PROVIDER_PRESETS.filter(preset => preset.id !== 'custom' && !configuredIds.has(preset.id)),
    [configuredIds],
  );

  const keyword = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!keyword) return remaining;
    return remaining.filter(preset => {
      const modalities = preset.modalities.map(modality => MODALITIES[modality] ?? modality).join(' ');
      const groupTitle = GROUPS.find(group => group.kind === preset.kind)?.title ?? '';
      return [preset.label, preset.id, modalities, groupTitle].join(' ').toLowerCase().includes(keyword);
    });
  }, [remaining, keyword]);

  const subscriptionText = subscriptionError
    ?? (!subscription
      ? (showSubLoading ? '加载中…' : '')
      : subscription.available
        ? [subscription.email, subscription.plan].filter(Boolean).join(' · ')
        : '请先在 Codex 里用 ChatGPT 登录');

  const canAnimate = catalogMotion === 'reveal' && motionAvailable();
  const reduced = prefersReducedMotion();

  const updateQuery = (next: string) => {
    setCatalogMotion('instant');
    setQuery(next);
  };

  return (
    <section aria-label="添加供应商" className="space-y-6 border-t border-border pt-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">添加供应商</h2>
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-56">
            <InputGroupAddon><SearchIcon aria-hidden /></InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              aria-label="查找可添加的供应商"
              placeholder="查找可添加的供应商"
              value={query}
              onChange={event => updateQuery(event.target.value)}
            />
            <AnimatePresence>
              {query.length > 0 && (
                <InputGroupAddon align="inline-end" className="px-1.5">
                  <motion.span
                    initial={motionAvailable() ? (reduced ? { opacity: 0 } : { opacity: 0, scale: 0.75 }) : false}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.75 }}
                    transition={{ duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }}
                    className="inline-flex"
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label="清空可添加供应商搜索"
                      onClick={() => { updateQuery(''); searchRef.current?.focus(); }}
                      className="size-6 rounded-sm border-0 text-muted-foreground hover:border-transparent hover:bg-secondary/70 hover:text-foreground hover:backdrop-blur-none"
                    >
                      <CloseIcon size="sm" aria-hidden />
                    </Button>
                  </motion.span>
                </InputGroupAddon>
              )}
            </AnimatePresence>
          </InputGroup>
          <Button variant="outline" type="button" className="px-3" onClick={() => onSelect(CUSTOM_PRESET)}>
            <AddIcon size="sm" aria-hidden />自定义供应商
          </Button>
        </div>
      </div>

      {remaining.length === 0 ? (
        <p className="content-swap-in text-sm text-muted-foreground">所有预置供应商均已配置，可通过右上角「自定义供应商」继续添加</p>
      ) : visible.length === 0 ? (
        <p className="content-swap-in text-sm text-muted-foreground">没有匹配的可添加供应商</p>
      ) : (
        <div className="space-y-6">
          <AnimatePresence initial={false}>
            {GROUPS.map(group => {
              const items = visible.filter(preset => preset.kind === group.kind);
              if (items.length === 0) return null;
              const isSubscription = group.kind === 'subscription';
              return (
                <motion.div
                  key={group.kind}
                  initial={canAnimate ? (reduced ? { opacity: 0 } : { opacity: 0, height: 0 }) : false}
                  animate={canAnimate ? { opacity: 1, height: 'auto' } : undefined}
                  exit={canAnimate ? (reduced
                    ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }
                    : { opacity: 0, height: 0, transition: { duration: MOTION_DURATION.base, ease: MOTION_EASE.inOut } }) : undefined}
                  transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE.out }}
                  className="-mx-2.5 overflow-hidden px-2.5"
                >
                  <div className="space-y-2 py-0.5">
                    <div className="flex items-baseline gap-2.5">
                      <h3 className="text-xs font-medium text-foreground">{group.title}</h3>
                      <span className="text-xs text-muted-foreground">{group.description}</span>
                    </div>
                    <div className={isSubscription
                      ? '-mx-2.5 grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2 lg:grid-cols-3'
                      : '-mx-2.5 grid grid-cols-2 gap-x-2 gap-y-1 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'}>
                    <AnimatePresence mode={canAnimate ? 'popLayout' : 'sync'} initial={false}>
                      {items.map(preset => (
                        <motion.div
                          key={preset.id}
                          layout={canAnimate && !reduced ? 'position' : false}
                          initial={canAnimate ? (reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }) : false}
                          animate={canAnimate ? { opacity: 1, scale: 1 } : undefined}
                          exit={canAnimate ? (reduced
                            ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }
                            : { opacity: 0, scale: 0.96, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }) : undefined}
                          transition={{
                            duration: MOTION_DURATION.base,
                            ease: MOTION_EASE.out,
                            layout: MOTION_SPRING.snappy,
                          }}
                        >
                          {isSubscription ? (
                            <Button
                              variant="ghost"
                              type="button"
                              data-press="none"
                              onClick={() => onSelect(preset)}
                              className="group/item h-auto w-full justify-start gap-2.5 rounded-md border-0 px-2.5 py-2 text-left font-normal text-foreground transition-[background-color,color,scale] duration-150 hover:border-transparent hover:bg-secondary/60 hover:backdrop-blur-none active:bg-secondary/90 motion-safe:active:scale-[0.985]"
                            >
                              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-150 group-hover/item:text-foreground">
                                <ProviderBrandIcon size="md" provider={{ provider: preset.value, base_url: preset.defaultBaseUrl }} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5 text-sm">
                                  <span className="truncate">{preset.label}</span>
                                  <AnimatePresence>
                                    {subscription?.available && (
                                      <motion.span
                                        key="sub-ok"
                                        aria-hidden
                                        initial={motionAvailable() ? (reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4 }) : false}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={reduced
                                          ? { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }
                                          : MOTION_SPRING.pop}
                                        className="size-1.5 shrink-0 rounded-full bg-[color:var(--status-done)]"
                                      />
                                    )}
                                  </AnimatePresence>
                                </span>
                                <span className="block min-h-4 truncate text-xs text-muted-foreground">
                                  {subscriptionText && <span key={subscriptionText} className="content-swap-in">{subscriptionText}</span>}
                                </span>
                              </span>
                            </Button>
                          ) : (
                            <Hint label={presetHint(preset)}>
                              <Button
                                variant="ghost"
                                type="button"
                                data-press="none"
                                onClick={() => onSelect(preset)}
                                className="group/item h-auto w-full justify-start gap-2.5 rounded-md border-0 px-2.5 py-2 text-left font-normal text-foreground transition-[background-color,color,scale] duration-150 hover:border-transparent hover:bg-secondary/60 hover:backdrop-blur-none active:bg-secondary/90 motion-safe:active:scale-[0.985]"
                              >
                                <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-150 group-hover/item:text-foreground">
                                  <ProviderBrandIcon size="md" provider={{ provider: preset.value, base_url: preset.defaultBaseUrl }} />
                                </span>
                                <span className="truncate text-sm">{preset.label}</span>
                              </Button>
                            </Hint>
                          )}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

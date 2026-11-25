import { useEffect, useState } from 'react';
import { recordOnboardingEvent } from '@/api/onboarding';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useRetained } from '@/components/ui/retained';
import { OPEN_ONBOARDING_EVENT, type GuideSource } from '@/lib/onboardingGuide';
import { OnboardingGuide } from '@/pages/onboarding/OnboardingGuide';

/** 首启之后「还没有可用模型」时的引导弹窗；由 openOnboarding() 打开。 */
export function OnboardingHost() {
  const [source, setSource] = useState<GuideSource | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: GuideSource }>).detail;
      setSource(detail?.source ?? 'model_chip');
    };
    window.addEventListener(OPEN_ONBOARDING_EVENT, open);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, open);
  }, []);
  // 关闭后沿用最后一次的来源，引导内容跟着弹窗一起退场。
  const shown = useRetained(source);
  if (!shown) return null;
  return (
    <Dialog open={Boolean(source)} onOpenChange={open => {
      if (open) return;
      void recordOnboardingEvent({ event: 'closed' });
      setSource(null);
    }}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[90dvh] max-w-2xl flex-col gap-6 overflow-y-auto p-6">
        <DialogTitle className="font-display text-display font-normal">连接一个模型</DialogTitle>
        <OnboardingGuide source={shown} onDone={() => setSource(null)} />
      </DialogContent>
    </Dialog>
  );
}

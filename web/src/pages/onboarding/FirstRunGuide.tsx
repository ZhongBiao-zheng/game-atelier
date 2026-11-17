import { useState } from 'react';
import { recordOnboardingEvent } from '@/api/onboarding';
import { Button } from '@/components/ui/button';
import { OnboardingFrame } from './OnboardingFrame';
import { OnboardingGuide } from './OnboardingGuide';

/** 首启第二步：连接模型。「稍后」记入本机后进首页，之后从模型菜单再打开。 */
export function FirstRunGuide({ onComplete }: { onComplete: () => void }) {
  const [skipping, setSkipping] = useState(false);
  const skip = async () => {
    setSkipping(true);
    await recordOnboardingEvent({ event: 'skipped' });
    onComplete();
  };
  return (
    <OnboardingFrame step={2} title="连接一个模型"
      footer={<Button variant="outline" type="button" disabled={skipping} onClick={() => { void skip(); }}>稍后</Button>}>
      <OnboardingGuide source="first_run" onDone={onComplete} />
    </OnboardingFrame>
  );
}

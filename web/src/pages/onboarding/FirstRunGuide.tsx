import { useState } from 'react';
import { recordOnboardingEvent } from '@/api/onboarding';
import { Button } from '@/components/ui/button';
import { OnboardingFrame } from './OnboardingFrame';
import { OnboardingGuide } from './OnboardingGuide';

/** 首启：连接模型。「稍后」记入本机后进首页，之后从模型菜单再打开。 */
export function FirstRunGuide({ onComplete, recovered = false }: { onComplete: () => void; recovered?: boolean }) {
  const [skipping, setSkipping] = useState(false);
  const skip = async () => {
    setSkipping(true);
    await recordOnboardingEvent({ event: 'skipped' });
    onComplete();
  };
  return (
    <OnboardingFrame title="连接一个模型"
      footer={<Button variant="outline" type="button" disabled={skipping} onClick={() => { void skip(); }}>稍后</Button>}>
      {recovered && <p role="status" className="text-sm text-muted-foreground">供应商配置损坏，原文件已备份，需重新添加</p>}
      <OnboardingGuide source="first_run" onDone={onComplete} />
    </OnboardingFrame>
  );
}

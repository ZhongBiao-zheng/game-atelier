import { useLayoutEffect, useRef, useState } from 'react';
import { chooseFolder } from '@/api/folders';
import { confirmDataRoot, fetchDataRoot, type DataRootMove } from '@/api/onboarding';
import { SwapLabel } from '@/components/ui/swap-label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Collapse } from '@/components/ui/collapse';
import { useRetained } from '@/components/ui/retained';
import { errorText } from '@/lib/errorText';
import { OnboardingFrame } from './OnboardingFrame';

const MOVE_POLL_MS = 400;
const moving = (move: DataRootMove) => move.phase === 'copying' || move.phase === 'verifying';
const wait = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

/** 首启第一步：存放位置。预填服务正在用的目录；换到别处时服务端把首启数据迁过去，迁完再进下一步。 */
export function DataRootPage({ initialPath, onComplete }: { initialPath: string; onComplete: () => void }) {
  const [path, setPath] = useState(initialPath);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = useRetained(error);
  // 长路径被截断时让末尾可见：最后一级文件夹才是用户要确认的部分。
  const pathInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const input = pathInput.current;
    if (input) input.scrollLeft = input.scrollWidth;
  }, [path]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      let { move } = await confirmDataRoot(path);
      while (moving(move)) {
        await wait(MOVE_POLL_MS);
        ({ move } = await fetchDataRoot());
      }
      if (move.phase === 'failed') throw new Error(move.error ?? '没能保存到这个位置');
      onComplete();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    setChoosing(true);
    setError(null);
    try {
      const picked = await chooseFolder('选择存放位置', path);
      if (picked) setPath(picked);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChoosing(false);
    }
  };

  return (
    <OnboardingFrame title="选择存放位置"
      footer={<Button type="button" onClick={() => { void save(); }} disabled={!path || saving || choosing}>
        <SwapLabel active={saving} on="保存中…" off="继续" />
      </Button>}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Label htmlFor="data-root-path" className="sr-only">存放位置</Label>
          <Input ref={pathInput} id="data-root-path" value={path} readOnly title={path} className="min-w-0 flex-1 font-mono" />
          <Button variant="outline" type="button" onClick={() => { void pickFolder(); }} disabled={saving || choosing}>
            <SwapLabel active={choosing} on="选择中…" off="更改" />
          </Button>
        </div>
        <Collapse open={Boolean(error)}><p role="alert" className="text-sm text-destructive">{shownError}</p></Collapse>
      </div>
    </OnboardingFrame>
  );
}

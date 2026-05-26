import { useEffect, useState } from 'react';

import { createStudioJob } from '@/api/studio';
import { listKeys, type KeyView } from '@/api/keys';
import { InspirationChips } from '@/components/studio/InspirationChips';
import { PromptInput } from '@/components/studio/PromptInput';
import { RoundList, type RoundState } from '@/components/studio/RoundList';

export function Studio({ compact = false }: { compact?: boolean }) {
  const [rounds, setRounds] = useState<RoundState[]>([]);
  const [pending, setPending] = useState(false);
  const [seedText, setSeedText] = useState('');
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [providerAlias, setProviderAlias] = useState('');
  const [model, setModel] = useState('');
  const [ratio, setRatio] = useState('1:1');
  const [resolution, setResolution] = useState<'2K' | '4K'>('2K');

  useEffect(() => {
    let cancelled = false;
    listKeys()
      .then((resp) => {
        if (cancelled) return;
        const usable = resp.keys.filter((key) => key.models.length > 0);
        setKeys(usable);
        const selected = usable.find((key) => key.alias === resp.default_alias) ?? usable[0];
        setProviderAlias(selected?.alias ?? '');
        setModel(selected?.models[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled) setKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (prompt: string) => {
    setPending(true);
    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, promptPreview: prompt };
    setRounds((rs) => [myRound, ...rs]);
    try {
      const job = await createStudioJob({
        prompt,
        alias: providerAlias,
        model,
        params: {
          size: sizeFor(ratio, resolution),
          ratio,
          resolution,
        },
      });
      await pollJobUntilTerminal(job.job_id, (final) => {
        setRounds((rs) =>
          rs.map((r) =>
            r === myRound
              ? final.status === 'done' && final.output_paths[0]
                ? {
                    kind: 'done',
                    submittedAt: final.submitted_at,
                    imagePath: final.output_paths[0],
                  }
                : {
                    kind: 'failed',
                    submittedAt: final.submitted_at,
                    reason: final.error ?? '生成完成但未返回图片',
                  }
              : r,
          ),
        );
      });
    } catch (e: any) {
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message } : r,
        ),
      );
    } finally {
      setPending(false);
    }
  };

  if (compact) {
    return (
      <div className="py-8" aria-label="生图沙箱">
        <h1 className="text-xl sm:text-2xl leading-tight mb-6 sm:mb-8 max-w-[780px] mx-auto font-semibold">
          描述你想生成的图片
        </h1>
        <PromptInput
          onSubmit={onSubmit}
          disabled={pending}
          initialValue={seedText}
          providers={keys}
          providerAlias={providerAlias}
          model={model}
          ratio={ratio}
          resolution={resolution}
          onProviderChange={setProviderAlias}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
        />
        {rounds.length === 0 && <InspirationChips onPick={(t) => setSeedText(t)} />}
        <RoundList rounds={rounds} />
      </div>
    );
  }

  return (
    <div
      className="h-[calc(100vh-56px)] md:h-[calc(100vh-80px)] flex flex-col overflow-hidden px-3 sm:px-6"
      aria-label="生图沙箱"
    >
      <div className="flex-1 min-h-0 overflow-y-auto py-6">
        {rounds.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <InspirationChips onPick={(t) => setSeedText(t)} />
          </div>
        ) : (
          <RoundList rounds={rounds} />
        )}
      </div>
      <div className="shrink-0 py-4 border-t border-border/30">
        <PromptInput
          onSubmit={onSubmit}
          disabled={pending}
          initialValue={seedText}
          providers={keys}
          providerAlias={providerAlias}
          model={model}
          ratio={ratio}
          resolution={resolution}
          onProviderChange={setProviderAlias}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
        />
      </div>
    </div>
  );
}

function sizeFor(ratio: string, resolution: '2K' | '4K') {
  const long = resolution === '4K' ? 4096 : 2048;
  const short = resolution === '4K' ? 2304 : 2048;
  if (ratio === '16:9') return `${long}x${short}`;
  if (ratio === '9:16') return `${short}x${long}`;
  if (ratio === '3:4') return resolution === '4K' ? '3072x4096' : '1536x2048';
  if (ratio === '4:3') return resolution === '4K' ? '4096x3072' : '2048x1536';
  if (ratio === '21:9') return resolution === '4K' ? '4096x1755' : '2048x878';
  return resolution === '4K' ? '4096x4096' : '2048x2048';
}

async function pollJobUntilTerminal(
  jobId: string,
  onFinal: (job: { status: string; submitted_at: string; output_paths: string[]; error: string | null }) => void,
) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const resp = await fetch(`/api/jobs/${jobId}`);
    if (!resp.ok) continue;
    const job = await resp.json();
    if (job.status === 'done' || job.status === 'failed') {
      onFinal(job);
      return;
    }
  }
  onFinal({ status: 'failed', submitted_at: new Date().toISOString(), output_paths: [], error: 'timeout' });
}

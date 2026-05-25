import { useState } from 'react';

import { createStudioJob } from '@/api/studio';
import { InspirationChips } from '@/components/studio/InspirationChips';
import { PromptInput } from '@/components/studio/PromptInput';
import { RoundList, type RoundState } from '@/components/studio/RoundList';

export function Studio() {
  const [rounds, setRounds] = useState<RoundState[]>([]);
  const [pending, setPending] = useState(false);
  const [seedText, setSeedText] = useState('');

  const onSubmit = async (prompt: string) => {
    setPending(true);
    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, promptPreview: prompt };
    setRounds((rs) => [myRound, ...rs]);
    try {
      const job = await createStudioJob({
        prompt,
        model: 'gpt-image-2',
        params: { size: '1024x1024' },
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

  return (
    <div className="px-6 py-8" aria-label="生图沙箱">
      <h1
        className="text-3xl mb-6 max-w-3xl mx-auto"
        style={{ fontFamily: "'Instrument Serif', serif" }}
      >
        Studio.
      </h1>
      <PromptInput onSubmit={onSubmit} disabled={pending} initialValue={seedText} />
      {rounds.length === 0 && <InspirationChips onPick={(t) => setSeedText(t)} />}
      <RoundList rounds={rounds} />
    </div>
  );
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

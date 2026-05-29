import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';

import { createStudioJob, getStudioJob, listStudioJobs } from '@/api/studio';
import { listKeys, type KeyView } from '@/api/keys';
import { PromptInput } from '@/components/studio/PromptInput';
import { RoundList, type RoundConfig, type RoundState } from '@/components/studio/RoundList';
import { studioSizeFor } from '@/lib/studioSize';
import type { Job } from '@/schema/jobs';

export function Studio({ compact = false }: { compact?: boolean }) {
  const [, setLocation] = useLocation();
  const [rounds, setRounds] = useState<RoundState[]>([]);
  const [persistedJobs, setPersistedJobs] = useState<Job[]>([]);
  const [pending, setPending] = useState(false);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [providerAlias, setProviderAlias] = useState('');
  const [model, setModel] = useState('');
  const [ratio, setRatio] = useState('1:1');
  const [resolution, setResolution] = useState<'2K' | '4K'>('2K');
  const [customSize, setCustomSize] = useState('');
  const [promptText, setPromptText] = useState('');
  const handleCustomSizeChange = useCallback((w: number, h: number) => {
    setCustomSize(`${w}x${h}`);
  }, []);

  const refreshPersistedJobs = useCallback(async () => {
    const jobs = await listStudioJobs();
    setPersistedJobs(jobs);
    return jobs;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!compact) {
      listStudioJobs()
        .then((jobs: Job[]) => {
          if (cancelled) return;
          setPersistedJobs(jobs);
        })
        .catch(() => {
          if (!cancelled) {
            setPersistedJobs([]);
          }
        });
    }
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
  }, [compact]);

  useEffect(() => {
    if (compact) return;
    setRounds((items) =>
      mergePersistedRounds(
        items.map((item) => hydrateRoundModelName(item, keys)),
        studioJobsToRounds(persistedJobs, keys),
      ),
    );
  }, [compact, keys, persistedJobs]);

  const hasActivePersistedJob = persistedJobs.some(
    (job) => job.status === 'pending' || job.status === 'pending_confirm',
  );

  useEffect(() => {
    if (compact || !hasActivePersistedJob) return;
    const id = window.setInterval(() => {
      void refreshPersistedJobs();
    }, 2000);
    return () => window.clearInterval(id);
  }, [compact, hasActivePersistedJob, refreshPersistedJobs]);

  const onSubmit = async (prompt: string, overrideConfig?: RoundConfig) => {
    const effectiveRatio = overrideConfig?.ratio ?? ratio;
    const effectiveResolution = overrideConfig?.resolution ?? resolution;
    const effectiveAlias = overrideConfig?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model ?? model;
    const selectedKey = keys.find((item) => item.alias === effectiveAlias);
    const effectiveProvider = selectedKey?.provider ?? overrideConfig?.provider;
    const effectiveSize = overrideConfig?.size ?? (customSize || studioSizeFor(effectiveRatio, effectiveResolution, effectiveProvider));
    const selectedModel = selectedKey?.models.find((item) => item.id === effectiveModel);
    const config: RoundConfig = {
      prompt,
      alias: effectiveAlias,
      provider: effectiveProvider,
      model: effectiveModel,
      modelName: selectedModel?.name ?? overrideConfig?.modelName,
      ratio: effectiveRatio,
      resolution: effectiveResolution,
      size: effectiveSize,
      referenceImages: overrideConfig?.referenceImages ?? [],
    };

    if (compact) {
      setPending(true);
      try {
        await createStudioJob({
          prompt,
          alias: effectiveAlias ?? undefined,
          model: effectiveModel,
          params: {
            size: effectiveSize,
            ratio: effectiveRatio,
            resolution: effectiveResolution,
          },
        });
        setLocation('/studio');
      } finally {
        setPending(false);
      }
      return;
    }

    setPending(true);
    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, config };
    setRounds((rs) => [myRound, ...rs]);
    try {
      const job = await createStudioJob({
        prompt,
        alias: effectiveAlias ?? undefined,
        model: effectiveModel,
        params: {
          size: effectiveSize,
          ratio: effectiveRatio,
          resolution: effectiveResolution,
        },
      });
      setPersistedJobs((items) => upsertJob(items, job));
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound
            ? {
                ...myRound,
                jobId: job.job_id,
                startedAt: Date.parse(job.submitted_at) || startedAt,
              }
            : r,
        ),
      );
      await pollJobUntilTerminal(job.job_id, (final) => {
        setPersistedJobs((items) => upsertJob(items, final));
        setRounds((rs) =>
          rs.map((r) =>
            r === myRound
              ? final.status === 'done' && final.output_paths.length > 0
                ? {
                    kind: 'done',
                    jobId: final.job_id,
                    submittedAt: final.submitted_at,
                    imagePaths: final.output_paths,
                    config,
                  }
                : {
                    kind: 'failed',
                    jobId: final.job_id,
                    submittedAt: final.submitted_at,
                    reason: final.error ?? '生成完成但未返回图片',
                    config,
                  }
              : r,
          ),
        );
      });
    } catch (e: any) {
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message, config } : r,
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
          value={promptText}
          onValueChange={setPromptText}
          providers={keys}
          providerAlias={providerAlias}
          model={model}
          ratio={ratio}
          resolution={resolution}
          onProviderChange={setProviderAlias}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
          onCustomSizeChange={handleCustomSizeChange}
          menuDirection="down"
        />
      </div>
    );
  }

  return (
    <div
      className="h-[calc(100vh-56px)] md:h-[calc(100vh-80px)] flex flex-col overflow-hidden px-3 sm:px-6"
      aria-label="生图沙箱"
    >
      <div className="flex-1 min-h-0 overflow-y-auto py-6">
        <RoundList
          rounds={rounds}
          onDeleteFailed={deleteFailedRound}
          onReEdit={reEdit}
          onRegenerate={regenerate}
          onDeleteBatch={deleteDoneBatch}
        />
      </div>
      <div className="shrink-0 py-4 border-t border-border/30">
        <PromptInput
          onSubmit={onSubmit}
          disabled={pending}
          value={promptText}
          onValueChange={setPromptText}
          providers={keys}
          providerAlias={providerAlias}
          model={model}
          ratio={ratio}
          resolution={resolution}
          onProviderChange={setProviderAlias}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
          onCustomSizeChange={handleCustomSizeChange}
          menuDirection="up"
        />
      </div>
    </div>
  );

  async function deleteFailedRound(jobId: string) {
    const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    if (!resp.ok) return;
    setRounds((items) => items.filter((item) => item.kind !== 'failed' || item.jobId !== jobId));
  }

  function reEdit(config: RoundConfig) {
    setPromptText(config.prompt);
    if (config.alias) setProviderAlias(config.alias);
    setModel(config.model);
    if (config.ratio) setRatio(config.ratio);
    if (config.resolution) setResolution(config.resolution);
  }

  async function regenerate(config: RoundConfig) {
    if (config.alias) setProviderAlias(config.alias);
    setModel(config.model);
    if (config.ratio) setRatio(config.ratio);
    if (config.resolution) setResolution(config.resolution);
    await onSubmit(config.prompt, config);
  }

  async function deleteDoneBatch(jobId: string, imagePaths: string[]) {
    const responses = await Promise.all(
      imagePaths.map((path) =>
        fetch(`/api/jobs/${encodeURIComponent(jobId)}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
      ),
    );
    if (responses.some((resp) => !resp.ok)) return;
    setRounds((items) => items.filter((item) => item.kind !== 'done' || item.jobId !== jobId));
  }
}

function referenceImagesFor(job: Job): string[] {
  const params = job.params ?? {};
  const refs = [
    job.source_image,
    ...(Array.isArray(params.reference_images) ? params.reference_images : []),
    ...(Array.isArray(params.lovart_attachments) ? params.lovart_attachments : []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return Array.from(new Set(refs));
}

function configForJob(job: Job, keys: KeyView[] = []): RoundConfig {
  const selectedKey = keys.find((item) => item.alias === job.alias);
  const selectedModel = selectedKey?.models.find((item) => item.id === job.model);
  return {
    prompt: job.prompt,
    alias: job.alias,
    provider: job.provider,
    model: job.model,
    modelName: selectedModel?.name,
    ratio: typeof job.params.ratio === 'string' ? job.params.ratio : undefined,
    resolution: job.params.resolution === '4K' ? '4K' : job.params.resolution === '2K' ? '2K' : undefined,
    size: typeof job.params.size === 'string' ? job.params.size : undefined,
    referenceImages: referenceImagesFor(job),
  };
}

function hydrateRoundModelName(round: RoundState, keys: KeyView[]): RoundState {
  const config = round.config;
  if (!config) return round;
  const selectedKey = keys.find((item) => item.alias === config.alias);
  const selectedModel = selectedKey?.models.find((item) => item.id === config.model);
  if (!selectedModel?.name || config.modelName === selectedModel.name) return round;
  return { ...round, config: { ...config, modelName: selectedModel.name } };
}

function studioJobsToRounds(jobs: Job[], keys: KeyView[] = []): RoundState[] {
  return jobs
    .filter((job) => job.namespace === 'studio')
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))
    .flatMap((job): RoundState[] => {
      if (job.status === 'done') {
        if (job.output_paths.length === 0) return [];
        return [{
          kind: 'done' as const,
          jobId: job.job_id,
          submittedAt: job.submitted_at,
          imagePaths: job.output_paths,
          config: configForJob(job, keys),
        }];
      }
      if (job.status === 'failed') {
        return [{
          kind: 'failed' as const,
          jobId: job.job_id,
          submittedAt: job.submitted_at,
          reason: job.error ?? '生成失败',
          config: configForJob(job, keys),
        }];
      }
      return [{
        kind: 'pending' as const,
        jobId: job.job_id,
        startedAt: Date.parse(job.submitted_at) || Date.now(),
        config: configForJob(job, keys),
      }];
    });
}

function roundKey(round: RoundState): string | null {
  if (round.kind === 'done') return round.jobId;
  if (round.kind === 'failed' && round.jobId) return round.jobId;
  if (round.kind === 'pending' && round.jobId) return round.jobId;
  return null;
}

function mergePersistedRounds(current: RoundState[], persisted: RoundState[]): RoundState[] {
  const persistedKeys = new Set(persisted.map(roundKey).filter((key): key is string => Boolean(key)));
  const localOnly = current.filter((item) => {
    const key = roundKey(item);
    return !key || !persistedKeys.has(key);
  });
  return [...localOnly, ...persisted];
}

async function pollJobUntilTerminal(
  jobId: string,
  onFinal: (job: Job) => void,
) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await getStudioJob(jobId);
    if (!job) continue;
    if (job.status === 'done' || job.status === 'failed') {
      onFinal(job);
      return;
    }
  }
  onFinal({
    job_id: jobId,
    character_id: '',
    prompt: '',
    submitted_at: new Date().toISOString(),
    model: '',
    params: {},
    seed: null,
    output_paths: [],
    status: 'failed',
    error: 'timeout',
    kind: 'image',
    namespace: 'studio',
  });
}

function upsertJob(items: Job[], next: Job): Job[] {
  const without = items.filter((item) => item.job_id !== next.job_id);
  return [next, ...without];
}

import { AlertTriangle, Link2 } from 'lucide-react';

import { ApiError } from '@/api/http';
import type { CanvasGenerationSnapshot, Job } from '@/schema/jobs';

interface CanvasNodeIdentity {
  id: string;
  title: string;
}

const PARAM_LABELS: Record<string, string> = {
  size: '尺寸',
  ratio: '比例',
  quality: '质量',
  background: '背景',
  n: '结果数量',
  duration: '时长',
  resolution: '分辨率',
  mode: '生成档位',
  frame_mode: '帧模式',
  generate_audio: '生成音频',
  watermark: '水印',
  temperature: '温度',
  max_tokens: '最大输出',
  reasoning_effort: '推理强度',
  voice: '音色',
  speed: '语速',
  response_format: '格式',
  instructions: '语音指令',
  angle_horizontal: '水平角度',
  angle_pitch: '俯仰角度',
  angle_distance: '镜头距离',
  angle_wide: '广角',
  bot_type: 'Midjourney 类型',
  mj_version: 'Midjourney 版本',
  mj_stylize: '风格化',
  mj_chaos: '混沌',
  mj_weird: '奇异',
  mj_seed: 'Seed',
  mj_no: '排除词',
  mj_tile: '无缝平铺',
  mj_iw: '垫图权重',
  mj_sw: '风格权重',
  mj_cw: '角色权重',
  mj_ow: 'Omni 权重',
};

const REFERENCE_PARAM_KEYS = new Set([
  'reference_images',
  'reference_videos',
  'reference_audios',
  'mask_image',
  'mj_sref',
  'mj_cref',
  'mj_oref',
]);

function isSensitiveParameterKey(key: string): boolean {
  return /(?:authorization|api[_-]?key|access[_-]?key|x[-_]api[-_]key|x[-_]auth[-_]token|client[-_]secret|private[-_]key|password|secret|token|signature|(^|_)key$)/i.test(key);
}

function sanitizeParameter(value: unknown, key = ''): unknown {
  if (isSensitiveParameterKey(key)) return '敏感值（已隐藏）';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (
      trimmed.startsWith('[') && trimmed.endsWith(']')
    )) {
      try {
        return sanitizeParameter(JSON.parse(trimmed));
      } catch {
        // Not JSON: continue with ordinary string redaction.
      }
    }
    if (/^(?:file:\/\/|\/|~\/|[a-z]:[\\/]|\\\\)/i.test(value)) {
      return '本地文件（路径已隐藏）';
    }
    return value
      .replace(/\b(https?:\/\/)[^/@\s]+@/gi, '$1<redacted>@')
      .replace(
        /(^|[^\w?&-])((?:\\?["'])?(?:authorization|api[_-]?key|access[_-]?key|secret[_-]?key|x[-_]api[-_]key|x[-_]auth[-_]token|client[-_]secret|private[-_]key|access_token|auth_token|password|token)(?:\\?["'])?\s*[:=]\s*)(?:\\?["'][^"']*\\?["']|bearer\s+[^\s,;}]+|[^\s,;}]+)/gi,
        '$1$2<redacted>',
      )
      .replace(
        /([?&][^=&#\s]+)=([^&#\s]*)/g,
        '$1=<redacted>',
      );
  }
  if (Array.isArray(value)) return value.map(item => sanitizeParameter(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeParameter(nestedValue, nestedKey),
      ]),
    );
  }
  return value;
}

function formatParameter(value: unknown, key: string): string {
  const sanitized = sanitizeParameter(value, key);
  if (typeof sanitized === 'boolean') return sanitized ? '开启' : '关闭';
  if (typeof sanitized === 'string' || typeof sanitized === 'number') return String(sanitized);
  if (Array.isArray(sanitized)) {
    return sanitized
      .map(item => item && typeof item === 'object' ? JSON.stringify(item) : String(item))
      .join('、');
  }
  return JSON.stringify(sanitized);
}

function kindLabel(kind: CanvasGenerationSnapshot['mode']): string {
  return { text: '文本', image: '图片', video: '视频', audio: '音频' }[kind];
}

function generationRecordPrompt(finalPrompt: string): string {
  const separator = '\n\n参考文本：\n';
  const separatorIndex = finalPrompt.indexOf(separator);
  if (separatorIndex < 0) return finalPrompt;
  const prompt = finalPrompt.slice(0, separatorIndex);
  const frozenText = finalPrompt.slice(separatorIndex + separator.length);
  const references = new Map<string, string>();
  for (const match of frozenText.matchAll(/(?:^|\n\n)【文本(\d+)】\n([\s\S]*?)(?=\n\n【文本\d+】\n|$)/g)) {
    references.set(match[1], match[2].trim());
  }
  const inlineReferences = new Set(
    [...prompt.matchAll(/【文本(\d+)】/g)].map(match => match[1]),
  );
  const displayPrompt = prompt.replace(/【文本(\d+)】/g, (_label, index: string) => (
    references.get(index) || '空文本'
  )).trim();
  const appendedReferences = [...references.entries()]
    .filter(([index]) => !inlineReferences.has(index))
    .map(([, text]) => text || '空文本');
  const sections = [displayPrompt];
  if (appendedReferences.length) {
    sections.push(`参考文本：\n${appendedReferences.join('\n\n')}`);
  }
  return sections.filter(Boolean).join('\n\n') || '空提示词';
}

export function canvasRetryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.recovery ? `${error.message} ${error.recovery}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function CanvasGenerationMetadata({ snapshot, job, nodes }: {
  snapshot: CanvasGenerationSnapshot;
  job: Job;
  nodes: ReadonlyArray<CanvasNodeIdentity>;
}) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const parameters = Object.entries(snapshot.normalized_params)
    .filter(([key, value]) => !REFERENCE_PARAM_KEYS.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => ({
      key,
      label: PARAM_LABELS[key] ?? key,
      value: formatParameter(value, key),
    }));
  const warnings = job.params.warnings ?? [];

  return (
    <section role="region" aria-label="生成记录" className="space-y-4 rounded-lg border border-border bg-background p-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-label text-muted-foreground/70">生成记录</p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {generationRecordPrompt(snapshot.final_prompt)}
        </p>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <RecordItem label="模型" value={snapshot.model} />
        <RecordItem label="厂商" value={snapshot.provider} />
        {snapshot.alias && <RecordItem label="密钥别名" value={snapshot.alias} />}
        <RecordItem label="生成类型" value={kindLabel(snapshot.mode)} />
        {parameters.map(item => <RecordItem key={item.key} label={item.label} value={item.value} />)}
      </dl>

      <div>
        <p className="text-xs text-muted-foreground">冻结引用</p>
        {snapshot.inputs.length === 0 && !snapshot.mask_version_id ? (
          <p className="mt-1 text-sm text-muted-foreground">无参考输入</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {[...snapshot.inputs].sort((a, b) => a.order - b.order).map(input => {
              const node = nodeById.get(input.node_id);
              return (
                <li key={`${input.node_id}-${input.version_id}`} className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
                  <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-foreground">{node?.title ?? '节点已删除'}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground" title={input.version_id}>
                      {kindLabel(input.kind)} · {input.node_id} · {input.version_id}
                    </span>
                  </span>
                </li>
              );
            })}
            {snapshot.mask_version_id && (
              <li className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
                <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>
                  <span className="block text-foreground">局部编辑蒙版</span>
                  <span className="block font-mono text-xs text-muted-foreground">{snapshot.mask_version_id}</span>
                </span>
              </li>
            )}
          </ul>
        )}
      </div>

      {(job.params.actual_size || warnings.length > 0) && (
        <div className="space-y-2 rounded-md border border-[color:var(--status-pending)]/30 bg-card px-3 py-2">
          <p className="flex items-center gap-2 text-xs font-medium text-[color:var(--status-pending)]">
            <AlertTriangle className="size-4" aria-hidden="true" />执行结果
          </p>
          {job.params.actual_size && (
            <dl className="text-sm">
              <RecordItem label="实际尺寸" value={job.params.actual_size} />
            </dl>
          )}
          {warnings.length > 0 && (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {warnings.map(warning => <li key={warning}>{warning}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function RecordItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-foreground">{value}</dd>
    </div>
  );
}

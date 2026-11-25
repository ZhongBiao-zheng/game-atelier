import { useEffect, useRef, useState } from 'react';
import {
  createHttpProtocol, getHttpProtocol, updateHttpProtocol, validateHttpProtocol, type HttpProtocolDetail,
} from '@/api/httpProtocols';
import type {
  HttpProtocolCallPreview, HttpProtocolDocument, HttpProtocolIssue, HttpProtocolKind, HttpProtocolValidation,
} from '@/schema/httpProtocols';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import manual from '../../../../src/character_workflow/data/http_protocol_manual.md?raw';
import examples from './customInterfaceExamples.json';
import { CustomInterfaceAssist } from './CustomInterfaceAssist';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { Button } from '@/components/ui/button';
import { SwapLabel } from '@/components/ui/swap-label';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { FileInput } from '@/components/ui/file-input';
import { AiIcon, CheckIcon, CopyIcon, HelpIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';
import { Hint } from '@/components/ui/tooltip';
import { errorText } from '@/lib/errorText';
import { UNDO_DURATION_MS } from '@/lib/notify';

const VALIDATE_DELAY_MS = 400;
const COPIED_MS = 2000;
const MANUAL_FILENAME = 'Atelier 自定义接口接入说明.md';

/** 新建时可以从示例开始（同一份 JSON 由 pytest 逐条校验，示例本身必定合法）。 */
const EXAMPLES = examples as { id: string; label: string; document: HttpProtocolDocument }[];

export function examplesFor(kind: HttpProtocolKind) {
  return EXAMPLES.filter(example => example.document.kind === kind);
}

const HELP = (
  <div className="max-w-xs space-y-1 text-xs">
    <p>整值占位：$prompt $model $n；图片 / 视频另有 $ratio $resolution $images $image；视频另有 $duration $durationText $firstFrame $lastFrame；音频另有 $voice $speed $format $lyrics $instrumental；轮询地址用 {'${taskId}'}。</p>
    <p>字符串内插写 {'${name}'}，字面量 $ 写 $$。取值路径如 data.*.url。</p>
    <p>参考图编码 encode：data_url / base64 / file（表单上传）/ url（需先配置对象存储）。</p>
    <p>音频的同步接口可用 result.body = binary（响应体即音频）；hex 结果写 result.hex。</p>
    <p>不支持：签名、多步上传、回调、流式响应、图片与视频的二进制响应、参考视频 / 音频。</p>
  </div>
);

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function documentName(text: string): string {
  try {
    const name = (JSON.parse(text) as { name?: unknown }).name;
    return typeof name === 'string' && name.trim() ? name.trim() : 'interface';
  } catch {
    return 'interface';
  }
}

function CallPreview({ label, call }: { label: string; call: HttpProtocolCallPreview }) {
  const headers = Object.entries(call.headers).map(([name, value]) => `${name}: ${value}`).join('\n');
  const body = call.body === null || call.body === undefined ? '' : `\n\n${pretty(call.body)}`;
  return (
    <section aria-label={label} className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-secondary/40 p-3 font-mono text-xs">
        {`${call.method} ${call.url}\n${headers}${body}`}
      </pre>
    </section>
  );
}

interface Props {
  /** 受控弹窗：调用方关闭时传 false，带着原内容播完退场；不传即打开。 */
  open?: boolean;
  /** 编辑已有接口时的 id；新建时为 null。 */
  identifier: string | null;
  kind: HttpProtocolKind;
  baseUrl?: string;
  model?: string;
  onSaved: (saved: HttpProtocolDetail) => void;
  onClose: () => void;
}

/** JSON.parse 的报错（Unexpected token… at position 123）→「第 N 行附近 JSON 格式有误」。 */
function jsonErrorText(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const line = message.match(/line (\d+)/)?.[1];
  const position = message.match(/position (\d+)/)?.[1];
  const row = line ? Number(line) : position ? text.slice(0, Number(position)).split('\n').length : null;
  return row ? `第 ${row} 行附近 JSON 格式有误` : 'JSON 格式有误';
}

export function CustomInterfaceDialog({ open = true, identifier, kind, baseUrl, model, onSaved, onClose }: Props) {
  const kindExamples = examplesFor(kind);
  const [exampleId, setExampleId] = useState(kindExamples[0]?.id ?? '');
  const [text, setText] = useState(() => identifier ? '' : pretty(kindExamples[0]?.document ?? {}));
  const [loading, setLoading] = useState(Boolean(identifier));
  const [validation, setValidation] = useState<HttpProtocolValidation | null>(null);
  const [parseIssue, setParseIssue] = useState<HttpProtocolIssue | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const [assistOpen, setAssistOpen] = useState(false);
  // 生成前的模板正文：草稿直接填进编辑区，撤销回到这份。
  const [beforeDraft, setBeforeDraft] = useState<string | null>(null);
  // 打开时（或换示例前没动过时）的正文：和它不同就算有未保存的修改。
  const [pristine, setPristine] = useState<string | null>(() => identifier ? null : text);
  // 换示例 / 导入覆盖了手写内容：编辑区上方内联「已替换当前输入 · 撤销」8 秒（规格 2.1）。
  const [replaced, setReplaced] = useState(false);
  useEffect(() => {
    if (!replaced) return;
    const timer = window.setTimeout(() => setReplaced(false), UNDO_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [replaced]);
  const dirty = !saving && !loading && pristine !== null && text !== pristine;
  /** 用新正文覆盖编辑区；手写过的内容先存进 beforeDraft，可撤销。 */
  const replaceText = (next: string) => {
    if (text === pristine) setPristine(next);
    else { setBeforeDraft(text); setReplaced(true); }
    setText(next);
  };
  const editor = useRef<HTMLTextAreaElement>(null);
  const [manualCopied, setManualCopied] = useState(false);

  useEffect(() => {
    if (!identifier) return;
    let active = true;
    getHttpProtocol(identifier)
      .then(detail => { if (active) { setText(pretty(detail.document)); setPristine(pretty(detail.document)); } })
      .catch(e => { if (active) setError(errorText(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [identifier]);

  useEffect(() => {
    if (loading) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      setParseIssue(null);
    } catch (e) {
      setParseIssue({ path: 'JSON', message: jsonErrorText(text, e) });
      setValidation(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      validateHttpProtocol(parsed, { baseUrl, model })
        .then(result => { if (active) setValidation(result); })
        .catch(e => { if (active) setError(errorText(e)); });
    }, VALIDATE_DELAY_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [text, loading, baseUrl, model]);

  const issues = parseIssue ? [parseIssue] : validation?.issues ?? [];
  const canSave = !loading && !saving && !parseIssue && validation?.valid === true;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(text);
      const saved = identifier ? await updateHttpProtocol(identifier, parsed) : await createHttpProtocol(parsed);
      window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
      onSaved(saved);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const download = (content: string, type: string, filename: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = Object.assign(document.createElement('a'), { href: url, download: filename });
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const exportDocument = () => download(text, 'application/json', `${documentName(text)}.json`);

  // 接入说明与「AI 帮我配置」的提示词同源（data/http_protocol_manual.md），给用户粘给自己的 AI 代理。
  // 浏览器不让写剪贴板时改为下载同一份文件，说明总能交到用户手里。
  const copyManual = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(manual);
      setManualCopied(true);
      window.setTimeout(() => setManualCopied(false), COPIED_MS);
    } catch {
      download(manual, 'text/markdown', MANUAL_FILENAME);
      setError('浏览器不允许写入剪贴板，已下载为文件');
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !saving) onClose(); }}>
      <DialogContent dirty={dirty} aria-describedby={undefined} className="flex max-h-[90dvh] max-w-5xl flex-col gap-4"
        // 默认焦点会落到「?」上并弹出说明；打开即聚焦模板正文。
        onOpenAutoFocus={event => { event.preventDefault(); editor.current?.focus(); }}>
        <div className="flex items-center gap-2">
          <DialogTitle>自定义接口</DialogTitle>
          <Hint label={HELP}><span tabIndex={0} aria-label="写法说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
          <Button variant="ghost" size="sm" type="button" aria-pressed={assistOpen} disabled={loading}
            onClick={() => setAssistOpen(!assistOpen)}><AiIcon size="sm" />AI 帮我配置</Button>
          <Button variant="ghost" size="sm" type="button" onClick={() => void copyManual()}>
            {manualCopied ? <CheckIcon size="sm" /> : <CopyIcon size="sm" />}{manualCopied ? '已复制' : '复制接入说明'}</Button>
          {!identifier && kindExamples.length > 1 && <Select value={exampleId} onValueChange={value => {
            const example = kindExamples.find(item => item.id === value);
            if (!example) return;
            setExampleId(value);
            replaceText(pretty(example.document));
          }}>
            <SelectTrigger size="sm" aria-label="从示例开始" className="ml-auto mr-8 w-auto"><SelectValue /></SelectTrigger>
            <SelectContent>{kindExamples.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
          </Select>}
        </div>
        {assistOpen && <CustomInterfaceAssist kind={kind}
          onDraft={document => { setBeforeDraft(current => current ?? text); setText(pretty(document)); }}
          onUndo={beforeDraft === null ? null : () => { setText(beforeDraft); setBeforeDraft(null); }} />}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto md:grid-cols-2">
          <div className="flex min-h-0 flex-col gap-2">
            {replaced && beforeDraft !== null && !assistOpen && <p role="status" className="content-swap-in flex items-center gap-2 text-xs text-muted-foreground">
              已替换当前输入
              <Button variant="link" size="sm" type="button" className="h-auto px-0 text-xs" onClick={() => { setText(beforeDraft); setBeforeDraft(null); setReplaced(false); }}>撤销</Button>
            </p>}
            <Textarea ref={editor} aria-label="接口模板" value={text} disabled={loading} spellCheck={false}
              onChange={e => setText(e.target.value)}
              className="min-h-80 flex-1 font-mono text-xs" />
            {issues.length > 0 && <ul aria-label="模板问题" className="space-y-1 text-xs text-destructive">
              {issues.map((issue, index) => <li key={`${issue.path}-${index}`}><span className="font-mono">{issue.path}</span> {issue.message}</li>)}
            </ul>}
          </div>
          <div className="min-w-0 space-y-3">
            {validation?.preview
              ? <>
                <CallPreview label="提交" call={validation.preview.submit} />
                {validation.preview.poll && <CallPreview label="轮询" call={validation.preview.poll} />}
              </>
              : <p className="text-xs text-muted-foreground">{loading ? '加载中…' : '模板通过检查后显示请求预览'}</p>}
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <footer className="flex items-center gap-2">
          <FileInput ref={upload} accept=".json,application/json" onChange={e => {
            const file = e.target.files?.[0]; e.target.value = '';
            if (file) void file.text().then(replaceText);
          }} />
          <Button variant="ghost" size="sm" type="button" disabled={loading || saving} onClick={() => upload.current?.click()}>导入</Button>
          <Button variant="ghost" size="sm" type="button" disabled={loading || Boolean(parseIssue)} onClick={exportDocument}>导出</Button>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" type="button" disabled={saving} onClick={onClose}>取消</Button>
          <Button type="button" disabled={!canSave} onClick={() => void save()}><SwapLabel active={saving} on="保存中…" off="保存" /></Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

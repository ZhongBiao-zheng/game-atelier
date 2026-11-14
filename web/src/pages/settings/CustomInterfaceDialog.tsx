import { useEffect, useRef, useState } from 'react';
import {
  createHttpProtocol, getHttpProtocol, updateHttpProtocol, validateHttpProtocol, type HttpProtocolDetail,
} from '@/api/httpProtocols';
import type {
  HttpProtocolCallPreview, HttpProtocolDocument, HttpProtocolIssue, HttpProtocolKind, HttpProtocolValidation,
} from '@/schema/httpProtocols';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import examples from './customInterfaceExamples.json';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { FileInput } from '@/components/ui/file-input';
import { HelpIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';
import { Hint } from '@/components/ui/tooltip';

const VALIDATE_DELAY_MS = 400;

/** 新建时可以从示例开始（同一份 JSON 由 pytest 逐条校验，示例本身必定合法）。 */
const EXAMPLES = examples as { id: string; label: string; document: HttpProtocolDocument }[];

export function examplesFor(kind: HttpProtocolKind) {
  return EXAMPLES.filter(example => example.document.kind === kind);
}

const HELP = (
  <div className="max-w-xs space-y-1 text-xs">
    <p>整值占位：$prompt $model $n $ratio $resolution $images $image；视频另有 $duration $durationText $firstFrame $lastFrame；轮询地址用 {'${taskId}'}。</p>
    <p>字符串内插写 {'${name}'}，字面量 $ 写 $$。取值路径如 data.*.url。</p>
    <p>不支持：签名、多步上传、回调、二进制响应、参考视频 / 音频。</p>
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
  /** 编辑已有接口时的 id；新建时为 null。 */
  identifier: string | null;
  kind: HttpProtocolKind;
  baseUrl?: string;
  model?: string;
  onSaved: (saved: HttpProtocolDetail) => void;
  onClose: () => void;
}

export function CustomInterfaceDialog({ identifier, kind, baseUrl, model, onSaved, onClose }: Props) {
  const kindExamples = examplesFor(kind);
  const [exampleId, setExampleId] = useState(kindExamples[0]?.id ?? '');
  const [text, setText] = useState(() => identifier ? '' : pretty(kindExamples[0]?.document ?? {}));
  const [loading, setLoading] = useState(Boolean(identifier));
  const [validation, setValidation] = useState<HttpProtocolValidation | null>(null);
  const [parseIssue, setParseIssue] = useState<HttpProtocolIssue | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!identifier) return;
    let active = true;
    getHttpProtocol(identifier)
      .then(detail => { if (active) setText(pretty(detail.document)); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
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
      setParseIssue({ path: 'JSON', message: e instanceof Error ? e.message : String(e) });
      setValidation(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      validateHttpProtocol(parsed, { baseUrl, model })
        .then(result => { if (active) setValidation(result); })
        .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const exportDocument = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = Object.assign(document.createElement('a'), { href: url, download: `${documentName(text)}.json` });
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[90dvh] max-w-5xl flex-col gap-4"
        // 默认焦点会落到「?」上并弹出说明；打开即聚焦模板正文。
        onOpenAutoFocus={event => { event.preventDefault(); editor.current?.focus(); }}>
        <div className="flex items-center gap-2">
          <DialogTitle>自定义接口</DialogTitle>
          <Hint label={HELP}><span tabIndex={0} aria-label="写法说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
          {!identifier && kindExamples.length > 1 && <Select value={exampleId} onValueChange={value => {
            const example = kindExamples.find(item => item.id === value);
            if (!example) return;
            setExampleId(value);
            setText(pretty(example.document));
          }}>
            <SelectTrigger size="sm" aria-label="从示例开始" className="ml-auto mr-8 w-auto"><SelectValue /></SelectTrigger>
            <SelectContent>{kindExamples.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
          </Select>}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto md:grid-cols-2">
          <div className="flex min-h-0 flex-col gap-2">
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
              : <p className="text-xs text-muted-foreground">{loading ? '读取中…' : '模板通过检查后显示请求预览'}</p>}
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <footer className="flex items-center gap-2">
          <FileInput ref={upload} accept=".json,application/json" onChange={e => {
            const file = e.target.files?.[0]; e.target.value = '';
            if (file) void file.text().then(setText);
          }} />
          <Button variant="ghost" size="sm" type="button" disabled={loading || saving} onClick={() => upload.current?.click()}>导入</Button>
          <Button variant="ghost" size="sm" type="button" disabled={loading || Boolean(parseIssue)} onClick={exportDocument}>导出</Button>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" type="button" disabled={saving} onClick={onClose}>取消</Button>
          <Button type="button" disabled={!canSave} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Hint } from '@/components/ui/tooltip';

import {
  fetchPsExecuteLog, fetchPsStatus, psScriptSettings, type PsBridgeStatus, type PsExecuteLogEntry,
} from './api';

function statusText(status: PsBridgeStatus): string {
  if (!status.supported) return '当前系统暂不支持';
  if (status.version) return `Photoshop ${status.version}${status.active_document ? ` · ${status.active_document}` : ''}`;
  if (status.running) return 'Photoshop 已启动';
  return status.installed ? 'Photoshop 未启动' : '未检测到 Photoshop';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 连接状态行：打开时不和 Photoshop 说话；点「检测」才读版本（第一次会弹系统授权框）。 */
export function PsBridgeSettings() {
  const [status, setStatus] = useState<PsBridgeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchPsStatus(false)
      .then(next => { if (active) setStatus(next); })
      .catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, []);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      setStatus(await fetchPsStatus(true));
    } catch (e) {
      setError(message(e));
    } finally {
      setChecking(false);
    }
  }

  const app = status?.responsible_app;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
    <p role="status" className="text-xs text-muted-foreground">{status ? statusText(status) : '读取中…'}</p>
    {app && status?.supported && <Hint label={`第一次检测时，macOS 会请你允许 ${app} 控制 Photoshop；弹窗可能在其他窗口后面`}>
      <p className="w-fit text-xs text-muted-foreground">授权应用 {app}</p>
    </Hint>}
    <Button variant="ghost" size="sm" disabled={checking || !status?.supported} onClick={() => void check()}>
      {checking ? '检测中…' : '检测'}
    </Button>
    {error && <p role="alert" className="basis-full text-xs text-destructive">{error}</p>}
  </div>;
}

function firstLine(code: string): string {
  return code.split('\n').find(line => line.trim())?.trim() ?? '';
}

function time(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 「允许 Agent 执行脚本」开关（默认关）与最近的执行记录（ADR-0043）。 */
export function PsAgentScripts() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<PsExecuteLogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([psScriptSettings(), fetchPsExecuteLog()])
      .then(([settings, log]) => { if (active) { setAllowed(settings.allow_scripts); setEntries(log.entries); } })
      .catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      setAllowed((await psScriptSettings(next)).allow_scripts);
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }

  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Label className="flex items-center gap-2 text-xs font-normal leading-normal">
        <Switch size="sm" checked={allowed === true} disabled={allowed === null || saving}
          onCheckedChange={next => void toggle(next)} />
        允许 Agent 执行脚本
      </Label>
      {allowed && <p className="text-xs text-destructive">脚本可以读写本机文件</p>}
      {entries.length > 0 && <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        最近执行 {entries.length}
      </Button>}
    </div>
    <Collapse open={open && entries.length > 0}>
      <ul aria-label="最近执行" className="space-y-0.5">
        {entries.map((entry, index) => <li key={`${entry.at}-${index}`} className="flex min-w-0 gap-2 text-xs text-muted-foreground">
          <span className="shrink-0 tabular-nums">{time(entry.at)}</span>
          <span className="shrink-0">{entry.caller}</span>
          {!entry.ok && <span className="shrink-0 text-destructive">失败</span>}
          <Hint label={entry.ok ? entry.code : `${entry.error ?? ''}\n${entry.code}`}>
            <code className="min-w-0 truncate font-mono">{firstLine(entry.code)}</code>
          </Hint>
        </li>)}
      </ul>
    </Collapse>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

/** 设置 → 插件里 PS 联动下方的区域：连接状态、Agent 脚本开关与执行记录。 */
export function PsBridgeSettingsArea() {
  return <div className="space-y-1.5">
    <PsBridgeSettings />
    <PsAgentScripts />
  </div>;
}

import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { createAgentGrant, fetchAgentGrants, revokeAgentGrant, type AgentCapability, type AgentGrant } from '@/api/agentGrants';
import { fetchProjects } from '@/api/projects';
import { requestJson } from '@/api/http';
import type { ProjectsFile } from '@/schema/jobs';

interface CanvasProjectOption { project_id: string; name: string }

const CAPABILITIES: { value: AgentCapability; label: string }[] = [
  { value: 'read', label: '读取上下文与结果' },
  { value: 'edit_documents', label: '编辑工作流文档' },
  { value: 'create_targets', label: '创建角色、UI 或视频目标' },
  { value: 'prepare_generation', label: '准备生成（仍需你批准）' },
  { value: 'execute_generation', label: '直接执行生成（终端确认即批准，不经页面）' },
];
const CANVAS_CAPABILITIES: { value: AgentCapability; label: string }[] = [
  { value: 'canvas_read', label: '读取画布' },
  { value: 'canvas_edit', label: '编辑节点、连线与配置，导入本机文件' },
  { value: 'canvas_generate', label: '在画布上发起生成（直接扣费）' },
];

export function ConnectionPage() {
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [projects, setProjects] = useState<ProjectsFile['projects']>([]);
  const [name, setName] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [canvasProjects, setCanvasProjects] = useState<CanvasProjectOption[]>([]);
  const [canvasProjectIds, setCanvasProjectIds] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<AgentCapability[]>(['read']);
  const [days, setDays] = useState(7);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([fetchAgentGrants(), fetchProjects(), requestJson<CanvasProjectOption[]>('/api/canvas/project-options', '读取画布列表')]).then(([result, projectFile, canvasOptions]) => {
      if (active) { setGrants(result.grants); setProjects(projectFile.projects); setCanvasProjects(canvasOptions); }
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault(); setError(null); setBusy('create');
    try {
      const grant = await createAgentGrant({ name: name.trim(), project_ids: projectIds, canvas_project_ids: canvasProjectIds, capabilities, days });
      setGrants(current => [grant, ...current]); setCreating(false); setName('');
    } catch (error) { setError(String(error)); } finally { setBusy(null); }
  }
  async function revoke(grant: AgentGrant) {
    if (!window.confirm(`撤销「${grant.name}」的连接授权？已提交的生成不会因此取消。`)) return;
    setBusy(grant.grant_id); setError(null);
    try { await revokeAgentGrant(grant.grant_id); setGrants(current => current.filter(item => item.grant_id !== grant.grant_id)); }
    catch (error) { setError(String(error)); } finally { setBusy(null); }
  }
  async function copy(grant: AgentGrant) {
    try {
      await navigator.clipboard.writeText(grant.credential_path);
      setCopied(grant.grant_id);
    } catch { setError('无法访问剪贴板，请手动复制凭据文件路径。'); }
  }

  return <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="font-display text-display">本机 Agent 连接</h1><p className="mt-2 text-sm text-muted-foreground">按项目授权给 Codex 或 Claude，数据仍保留在本机。</p></div>
      <Link href="/workshop/requests" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">待批准生成</Link>
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!creating ? <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"><Plus size={16} aria-hidden />添加 Agent 授权</button> :
      <form onSubmit={event => void create(event)} className="space-y-5 rounded-lg border border-border bg-card p-5">
        <label className="block space-y-2 text-sm"><span>连接名称</span><input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：Codex 美术助手" className="block w-full rounded-md border border-input bg-transparent px-3 py-2 focus-visible:ring-1 focus-visible:ring-ring" /></label>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">允许访问的项目</legend>{projects.length === 0 && <p className="text-sm text-muted-foreground">先在工坊创建项目。</p>}{projects.map(project => <label key={project.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={projectIds.includes(project.id)} onChange={event => setProjectIds(current => event.target.checked ? [...current, project.id] : current.filter(id => id !== project.id))} />{project.name}</label>)}</fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">允许访问的画布</legend>{canvasProjects.length === 0 && <p className="text-sm text-muted-foreground">还没有画布项目。</p>}{canvasProjects.map(project => <label key={project.project_id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={canvasProjectIds.includes(project.project_id)} onChange={event => setCanvasProjectIds(current => event.target.checked ? [...current, project.project_id] : current.filter(id => id !== project.project_id))} />{project.name}</label>)}</fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">允许的工坊操作</legend>{CAPABILITIES.map(capability => <label key={capability.value} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={capability.value === 'read'} checked={capabilities.includes(capability.value)} onChange={event => setCapabilities(current => event.target.checked ? [...current, capability.value] : current.filter(value => value !== capability.value))} />{capability.label}</label>)}</fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">允许的画布操作</legend>{CANVAS_CAPABILITIES.map(capability => <label key={capability.value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={capabilities.includes(capability.value)} onChange={event => setCapabilities(current => event.target.checked ? [...current, capability.value] : current.filter(value => value !== capability.value))} />{capability.label}</label>)}</fieldset>
        <label className="flex items-center gap-3 text-sm">有效天数<input type="number" min={1} max={30} required value={days} onChange={event => setDays(Number(event.target.value))} className="w-20 rounded-md border border-input bg-transparent px-3 py-2" /></label>
        <div className="flex gap-2"><button disabled={busy !== null || (projectIds.length === 0 && canvasProjectIds.length === 0) || !name.trim()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy === 'create' ? '创建中…' : '创建授权'}</button><button type="button" onClick={() => setCreating(false)} className="rounded-md px-4 py-2 text-sm hover:bg-accent">取消</button></div>
      </form>}
    <section aria-label="已有 Agent 授权" className="space-y-3">
      {grants.length === 0 && !creating && <p className="py-8 text-sm text-muted-foreground">尚未授权任何 Agent。</p>}
      {grants.map(grant => <article key={grant.grant_id} className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-4"><h2 className="text-base font-medium">{grant.name}</h2><button type="button" aria-label={`撤销 ${grant.name}`} disabled={busy !== null} onClick={() => void revoke(grant)} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-destructive"><Trash2 size={16} aria-hidden /></button></div>
        <p className="text-sm text-muted-foreground">{[...grant.project_ids.map(id => projects.find(project => project.id === id)?.name ?? id), ...(grant.canvas_project_ids ?? []).map(id => `画布 · ${canvasProjects.find(project => project.project_id === id)?.name ?? id}`)].join(' · ')} · {new Date(grant.expires_at).toLocaleDateString()} 到期</p>
        <p className="text-xs text-muted-foreground">{grant.capabilities.map(value => [...CAPABILITIES, ...CANVAS_CAPABILITIES].find(item => item.value === value)?.label).filter(Boolean).join(' · ')}</p>
        <div className="flex items-start gap-2"><code className="min-w-0 flex-1 break-all rounded-md bg-background p-3 font-mono text-xs">{grant.credential_path}</code><button type="button" onClick={() => void copy(grant)} aria-label={`复制 ${grant.name} 凭据路径`} className="shrink-0 rounded-md p-3 hover:bg-accent"><Copy size={16} aria-hidden /></button></div>
        {copied === grant.grant_id && <p role="status" className="text-xs text-muted-foreground">已复制凭据文件路径，未复制密钥。</p>}
      </article>)}
    </section>
    <details className="border-t border-border pt-5 text-sm"><summary className="cursor-pointer text-muted-foreground">如何在 Agent 中使用</summary><div className="mt-3 space-y-3 text-muted-foreground"><p>在 Codex / Claude 的 MCP 设置中，使用已安装 game-atelier 环境的 Python 解释器启动。连接不会自动修改你的 Agent 配置。</p><code className="block break-all rounded-md bg-background p-3 font-mono text-xs">/absolute/path/to/python -m character_workflow.mcp --credentials /path/to/credential.json</code><p>将示例中的解释器替换为本机安装路径，凭据路径替换为上方复制的路径；不要粘贴凭据文件内容。</p><p>工具连接与 Skill 安装是两件事。加载对应工坊 Skill 后，Agent 可以准备请求；只有你在“待批准生成”中确认，才会调用生成服务。</p><p>MCP 只限制这些工具的权限，不会限制你另外授予 Agent 的文件或终端访问权。</p></div></details>
  </div>;
}

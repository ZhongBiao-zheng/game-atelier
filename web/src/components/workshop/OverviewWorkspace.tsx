import type { ProjectExperience } from '@/api/experience';
import type { ProjectWorkspaceSummary } from '@/api/workspaces';
import { Textarea } from '@/components/ui/textarea';

export function OverviewWorkspace({
  data,
  draft,
  summary,
  onDraftChange,
}: {
  data: ProjectExperience;
  draft: string;
  summary: ProjectWorkspaceSummary | null;
  onDraftChange: (value: string) => void;
}) {
  return (
    <div className="space-y-6" data-testid="project-overview">
      <div className="space-y-2">
        <label htmlFor="worldview" className="block text-base font-medium leading-none text-foreground/85">
          项目经验 / 世界观
        </label>
        <Textarea
          id="worldview"
          aria-label="项目经验 / 世界观"
          value={draft}
          onChange={event => onDraftChange(event.target.value)}
          className="min-h-[360px] resize-y bg-card/50 font-mono text-sm leading-[1.7]"
          spellCheck={false}
        />
      </div>
      <div className="divide-y divide-border border-y border-border">
        <WorkspaceSummary
          label="美术资产"
          value={`${summary?.art.characters ?? data.project.character_count} 个角色`}
          detail={`${summary?.art.canonical ?? 0} 项定稿${summary?.art.stale ? ` · ${summary.art.stale} 项过时` : ''}`}
        />
        <WorkspaceSummary
          label="UI 页面"
          value={`${summary?.ui.screens ?? 0} 个页面`}
          detail={summary?.ui.next_action ?? '建立 UI 工作流'}
        />
        <WorkspaceSummary
          label="视频企划"
          value={summary?.video.productions ? `${summary.video.productions} 个企划` : '尚未建立'}
          detail={summary?.video.next_action ?? '建立项目视频企划'}
        />
      </div>
    </div>
  );
}

function WorkspaceSummary({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className="grid gap-2 py-4 sm:grid-cols-[minmax(120px,0.55fr)_minmax(140px,0.7fr)_minmax(180px,1fr)] sm:items-baseline">
      <p className="text-xs uppercase tracking-label text-muted-foreground/70">{label}</p>
      <p className="text-base font-medium text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground sm:text-right">{detail}</p>
    </section>
  );
}

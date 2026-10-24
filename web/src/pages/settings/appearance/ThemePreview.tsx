import { BarChart3, KeyRound, Plus } from 'lucide-react';

export function ThemePreview() {
  return <div className="min-w-0 space-y-3" aria-label="主题实时预览">
    <p className="text-xs text-muted-foreground">实时预览</p>
    <div className="flex overflow-hidden rounded-xl border border-border bg-background">
      <div className="space-y-3 border-r border-border p-3">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground"><BarChart3 className="size-4" /></span>
        <span className="flex size-8 items-center justify-center text-muted-foreground"><KeyRound className="size-4" /></span>
      </div>
      <div className="min-w-0 flex-1 space-y-4 p-4">
        <p className="text-xs"><span className="text-subtle-foreground">观测 / </span>用量</p>
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">本月花费</p>
          <p className="text-base font-semibold tabular-nums">¥ 128.50</p>
          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className="accent-pill rounded-full px-2 py-0.5">↑ 12%</span>
            <span className="type-image rounded-full px-2 py-0.5">图片</span>
            <span className="type-video rounded-full px-2 py-0.5">视频</span>
            <span className="type-text rounded-full px-2 py-0.5">文本</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full w-2/3 rounded-full bg-primary" /></div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"><Plus className="size-3.5" />新建密钥</span>
      </div>
    </div>
  </div>;
}

const labels: Record<string, string> = { image: '图片', image_edit: '图片', layer_split: '图片', video: '视频', text: '文本', audio: '音频' };
const classes: Record<string, string> = { image: 'type-image', image_edit: 'type-image', layer_split: 'type-image', video: 'type-video', text: 'type-text' };
export function KindBadge({ kind, count }: { kind: string; count?: number }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs ${classes[kind] ?? 'bg-secondary text-muted-foreground'}`}>
    {labels[kind] ?? kind}{count !== undefined && ` ${count}`}
  </span>;
}

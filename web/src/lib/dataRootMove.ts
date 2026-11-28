import type { DataRootMove } from '@/api/onboarding';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** 存放位置迁移中的进度文案：首启与偏好设置共用。 */
export function moveLabel(move: DataRootMove): string {
  if (move.phase === 'verifying') return '校验中…';
  return `迁移中 ${formatBytes(move.copied_bytes)} / ${formatBytes(move.total_bytes)}`;
}

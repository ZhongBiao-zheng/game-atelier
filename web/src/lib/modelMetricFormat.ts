export function formatModelDuration(seconds: number): string {
  return `${Math.ceil(seconds / 10) * 10}s`;
}

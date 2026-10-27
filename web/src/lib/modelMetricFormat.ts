export function formatModelDuration(seconds: number): string {
  return `${Math.ceil(seconds / 10) * 10}s`;
}

export function formatModelPrice(price: number): string {
  return `${Number(price.toFixed(2))}¥`;
}

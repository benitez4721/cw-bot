export function parseNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

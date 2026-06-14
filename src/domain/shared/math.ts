export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function bpsToFraction(bps: number): number {
  return bps / 10_000;
}

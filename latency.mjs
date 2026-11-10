export function controlLatency(samples) {
  const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)],
    max: sorted.at(-1),
  };
}

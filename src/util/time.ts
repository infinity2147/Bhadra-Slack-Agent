/** Epoch seconds. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function minutesAgo(n: number): number {
  return now() - n * 60;
}

/** "1h 23m" / "22m" / "45s" */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** YYYYMMDD for incident IDs. */
export function dateStamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

export function slugify(text: string, maxLen = 24): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen)
      .replace(/-+$/g, '') || 'incident'
  );
}

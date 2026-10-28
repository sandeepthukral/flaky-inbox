const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function relativeAge(ms: number): string {
  if (ms < MIN) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} hours`;
  return `${Math.floor(ms / DAY)} days`;
}

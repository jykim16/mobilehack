export function formatPrice(cents: number, currency = 'USD') {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency });
}

export function formatCount(count: number) {
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`;
  if (count >= 1_000) return `${trim(count / 1_000)}K`;
  return String(count);
}

function trim(value: number) {
  return value.toFixed(1).replace(/\.0$/, '');
}

export function etaDate(eta: string) {
  const [year, month, day] = eta.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatDay(date: Date | number) {
  return new Date(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatShortDate(date: Date | number) {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function isToday(date: Date | number) {
  return new Date(date).toDateString() === new Date().toDateString();
}

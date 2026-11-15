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

export function formatShortDate(date: Date | number) {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatDateTime(date: Date | number) {
  return new Date(date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatPostedDate(date: number) {
  const sameYear = new Date(date).getFullYear() === new Date().getFullYear();
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function formatAgo(date: number, now: number) {
  const minutes = Math.floor((now - date) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return formatShortDate(date);
}

export function isToday(date: Date | number) {
  return new Date(date).toDateString() === new Date().toDateString();
}

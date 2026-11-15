export const colors = {
  bg: "#F5F4F0",
  card: "#FFFFFF",
  text: "#14141A",
  muted: "#6B6B76",
  faint: "#A3A3AD",
  border: "#ECEBE6",
  accent: "#5146E5",
  accentSoft: "#EDEBFF",
  green: "#12A150",
  greenSoft: "#E3F6EA",
  amber: "#D98A04",
  amberSoft: "#FDF1DC",
  red: "#E0464B",
  redSoft: "#FDE6E6",
  agent: "#0E7C86",
  agentSoft: "#DDF3F4",
};

export function scoreColor(score: number) {
  if (score >= 75) return { fg: colors.green, bg: colors.greenSoft, label: "Confident" };
  if (score >= 55) return { fg: colors.amber, bg: colors.amberSoft, label: "Think it over" };
  return { fg: colors.red, bg: colors.redSoft, label: "Not yet" };
}

export const radius = { card: 22, pill: 999 };

export function money(cents: number | undefined) {
  if (cents === undefined) return "—";
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ago(ms: number, now: number) {
  const m = Math.max(0, (now - ms) / 60000);
  if (m < 60) return `${Math.max(1, Math.round(m))}m ago`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function hoursLabel(h: number) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

import { v } from "convex/values";
import { env, internalAction } from "./_generated/server";
import { pointsFromSeries, type HistoryPoint } from "./lib/keepa";

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

const KEEPA_SCHEMA = {
  type: "object",
  properties: {
    seriesLabel: { type: ["string", "null"], description: "The chart series label Keepa prints, e.g. Amazon or Buy Box" },
    currency: { type: ["string", "null"], description: "ISO currency of the chart" },
    chartReadable: { type: ["string", "null"], description: "'dom' when the chart exposes values, 'canvas' when it is only painted" },
    points: {
      type: ["array", "null"],
      description: "Dated prices read from the chart, oldest first",
      items: {
        type: "object",
        properties: {
          date: { type: ["string", "null"], description: "ISO date of the observation" },
          price: { type: ["number", "null"], description: "Price in the chart currency" },
        },
      },
    },
    evidence: { type: ["string", "null"], description: "Verbatim label or tooltip text supporting the points" },
  },
  required: ["points", "evidence"],
} as const;

const READ_CHART_SCRIPT = [
  "(() => {",
  "  const charts = (window.Highcharts && window.Highcharts.charts) || [];",
  "  const chart = charts.filter(Boolean)[0];",
  "  if (!chart) return JSON.stringify({ chart: false, title: document.title, text: document.body.innerText.slice(0, 300) });",
  "  const series = chart.series.map((s) => ({ name: s.name, points: (s.options.data || []).slice(-160) }));",
  "  return JSON.stringify({ chart: true, series });",
  "})()",
].join("\n");

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads the Keepa product page through Firecrawl twice over: structured JSON
 * first, then a JavaScript action that reads the live Highcharts instance when
 * the chart is painted on a canvas. Never throws; the caller decides the fallback.
 */
export const extractPriceHistory = internalAction({
  args: { url: v.string() },
  returns: v.object({
    ok: v.boolean(),
    mode: v.union(
      v.literal("live"),
      v.literal("sampled"),
      v.literal("blocked"),
      v.literal("error"),
    ),
    seriesLabel: v.union(v.string(), v.null()),
    currency: v.union(v.string(), v.null()),
    points: v.array(v.object({ at: v.union(v.number(), v.null()), priceCents: v.number() })),
    chartReadable: v.union(v.string(), v.null()),
    evidence: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
  }),
  handler: async (_ctx, { url }) => {
    const key = env.FIRECRAWL_API_KEY;
    const base = {
      ok: false,
      seriesLabel: null as string | null,
      currency: null as string | null,
      points: [] as HistoryPoint[],
      chartReadable: null as string | null,
      evidence: null as string | null,
      note: null as string | null,
    };
    if (!key) return { ...base, mode: "error" as const, note: "FIRECRAWL_API_KEY is not set on this deployment" };

    let res: Response;
    try {
      res = await fetch(FIRECRAWL_ENDPOINT, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          formats: [
            {
              type: "json",
              schema: KEEPA_SCHEMA,
              prompt:
                "Extract the Amazon price history chart series: its label, currency, and dated price points. " +
                "If the chart is canvas-only and shows no values, set points to null.",
            },
          ],
          actions: [
            { type: "wait", milliseconds: 5000 },
            { type: "executeJavascript", script: READ_CHART_SCRIPT },
          ],
        }),
      });
    } catch (e) {
      return { ...base, mode: "error" as const, note: "Keepa request failed: " + (e instanceof Error ? e.message : String(e)) };
    }
    const text = await res.text();
    if (!res.ok) {
      return { ...base, mode: "error" as const, note: "Keepa scrape HTTP " + res.status + ": " + text.slice(0, 200) };
    }
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return { ...base, mode: "error" as const, note: "Keepa scrape returned non-JSON" };
    }
    const data = body?.data ?? {};
    const json = data.json ?? {};
    const chartReadable = asString(json.chartReadable);
    const jsReturn = data?.actions?.javascriptReturns?.[0]?.value;
    let chartPayload: any = null;
    if (typeof jsReturn === "string") {
      try {
        chartPayload = JSON.parse(jsReturn);
      } catch {
        chartPayload = null;
      }
    }
    const series = Array.isArray(chartPayload?.series) ? chartPayload.series : [];
    if (series.length > 0) {
      const named = series.find((s: any) => typeof s?.name === "string" && s.points?.length) ?? series[0];
      const points = pointsFromSeries(named?.points);
      if (points.length > 0) {
        return {
          ...base,
          ok: true,
          mode: "live" as const,
          seriesLabel: asString(named?.name),
          currency: asString(json.currency) ?? "USD",
          points,
          chartReadable: "highcharts-dom",
          evidence: asString(json.evidence),
          note: null,
        };
      }
    }
    const extracted = Array.isArray(json.points) ? json.points : [];
    const sampled = extracted
      .map((p: any) => ({
        at: asString(p?.date) ? Date.parse(String(p.date)) : null,
        priceCents: typeof p?.price === "number" ? Math.round(p.price * 100) : null,
      }))
      .filter((p: any) => typeof p.priceCents === "number") as HistoryPoint[];
    if (sampled.length > 0) {
      return {
        ...base,
        ok: true,
        mode: "sampled" as const,
        seriesLabel: asString(json.seriesLabel),
        currency: asString(json.currency) ?? "USD",
        points: sampled.slice(-40),
        chartReadable: chartReadable ?? "dom",
        evidence: asString(json.evidence),
        note: "Sampled from Keepa",
      };
    }
    const pageText = String(chartPayload?.text ?? "");
    const walled = /anti-bot|log in|register|one-time password/i.test(pageText) || chartPayload?.chart === false;
    return {
      ...base,
      ok: false,
      mode: "blocked" as const,
      chartReadable: chartReadable ?? (chartPayload?.chart === false ? "canvas" : null),
      note: walled
        ? "Keepa served a sign-in or anti-bot page with no readable chart (title: " + (asString(chartPayload?.title) ?? "unknown") + ")."
        : "Keepa returned no readable price points.",
    };
  },
});

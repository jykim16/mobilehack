import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { sha256 } from "./agents";
import { scrapeProduct } from "./lib/scrape";

const http = httpRouter();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
}

function cents(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}

http.route({
  path: "/api/items",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});

http.route({
  path: "/api/items",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const key = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!key) return json({ error: "Missing Authorization: Bearer <api key>" }, 401);
    const agent = await ctx.runQuery(internal.agents.byKeyHash, { keyHash: await sha256(key) });
    if (!agent) return json({ error: "Invalid API key" }, 401);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json({ error: "Body must be a JSON object" }, 400);
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
    if (!/^https?:\/\//.test(url)) return json({ error: "url (http/https) is required" }, 400);
    if (!rationale) return json({ error: "rationale is required: tell the human why you picked this" }, 400);

    const needsScrape = !body.title || body.price === undefined || !body.imageUrl;
    const scraped = needsScrape ? await scrapeProduct(url) : { merchantDomain: undefined };
    const title = (typeof body.title === "string" && body.title.trim()) || scraped.title || url;
    const alternatives = Array.isArray(body.alternatives)
      ? body.alternatives
          .filter((a: any) => a && typeof a.title === "string")
          .slice(0, 5)
          .map((a: any) => ({
            title: String(a.title),
            price: cents(a.price),
            url: typeof a.url === "string" ? a.url : undefined,
            reason: typeof a.reason === "string" ? a.reason : undefined,
          }))
      : undefined;

    const itemId = await ctx.runMutation(internal.items.addFromAgent, {
      agentId: agent._id,
      title,
      url,
      imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : scraped.imageUrl,
      price: cents(body.price) ?? scraped.price,
      wasPrice: cents(body.wasPrice),
      rationale,
      alternatives,
      coolingOffHours: typeof body.coolingOffHours === "number" ? body.coolingOffHours : undefined,
      merchantDomain: scraped.merchantDomain,
    });
    return json({ ok: true, itemId, title, addedBy: agent.name }, 201);
  }),
});

export default http;

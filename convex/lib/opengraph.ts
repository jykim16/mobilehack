import { resolveImageUrl } from "./firecrawlExtract";
import { canonicalKeyForUrl } from "./urls";

export type OpenGraph = {
  title?: string;
  image?: string;
  description?: string;
  priceCents?: number;
  siteName?: string;
};

function meta(html: string, key: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[:.]/g, "\\$&")}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key.replace(/[:.]/g, "\\$&")}["']`,
    "i",
  );
  const m = html.match(re);
  return (m?.[1] ?? m?.[2])?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return (match?.[1] ?? match?.[2])?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function listingKey(url: string): string | null {
  const key = canonicalKeyForUrl(url);
  if (!key?.startsWith("amazon:")) return key;
  const mobileAsin = new URL(url).pathname.match(/\/gp\/aw\/d\/([A-Z0-9]{10})(?:\/|$)/i)?.[1];
  return mobileAsin ? `amazon:${mobileAsin.toUpperCase()}` : key;
}

export function parseOpenGraph(html: string, url: string): OpenGraph {
  const key = listingKey(url);
  let image = resolveImageUrl(meta(html, "og:image") ?? null, url);
  if (key?.startsWith("amazon:")) {
    const asinTag = html.match(/<input\b[^>]*\sid=["']ASIN["'][^>]*>/i)?.[0];
    const asin = asinTag ? attribute(asinTag, "value") : undefined;
    if (!asin || key !== `amazon:${asin.toUpperCase()}`) return {};
    const mainImage = html.match(/<img\b[^>]*\sid=["'](?:landingImage|imgBlkFront)["'][^>]*>/i)?.[0];
    if (!image && mainImage) {
      for (const name of ["data-a-hires", "data-old-hires", "src"]) {
        image = resolveImageUrl(attribute(mainImage, name) ?? null, url);
        if (image) break;
      }
    }
  }
  const price = meta(html, "product:price:amount") ?? meta(html, "og:price:amount");
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  return {
    title: meta(html, "og:title") ?? titleTag,
    image: image ?? undefined,
    description: meta(html, "og:description") ?? meta(html, "description"),
    siteName: meta(html, "og:site_name"),
    priceCents: price && !Number.isNaN(Number(price)) ? Math.round(Number(price) * 100) : undefined,
  };
}

export async function fetchOpenGraph(url: string): Promise<OpenGraph> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CartBot/0.1; +https://github.com/jykim16/mobilehack)",
      Accept: "text/html",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const key = listingKey(url);
  if (key?.startsWith("amazon:") && listingKey(res.url || url) !== key) return {};
  const html = (await res.text()).slice(0, 1_500_000);
  return parseOpenGraph(html, url);
}

export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter((s) => s.length > 3 && !/^[A-Z0-9]{10}$/.test(s) && s !== "dp")[0];
    return seg ? decodeURIComponent(seg).replace(/[-_]+/g, " ").replace(/\.p$/, "") : u.hostname;
  } catch {
    return url;
  }
}

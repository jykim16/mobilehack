import { merchantDomain } from "./merchants";

export type Scraped = {
  title?: string;
  imageUrl?: string;
  price?: number;
  merchantDomain?: string;
};

function decode(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function meta(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key}["'][^>]*content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${key}["']`, "i"),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return decode(m[1]);
    }
  }
  return undefined;
}

function toCents(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
}

export async function scrapeProduct(url: string): Promise<Scraped> {
  const result: Scraped = { merchantDomain: merchantDomain(url) };
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const html = (await res.text()).slice(0, 600_000);
    result.title =
      meta(html, ["og:title", "twitter:title"]) ??
      (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] && decode(html.match(/<title[^>]*>([^<]+)<\/title>/i)![1]));
    result.imageUrl = meta(html, ["og:image", "og:image:secure_url", "twitter:image"]);
    result.price =
      toCents(meta(html, ["product:price:amount", "og:price:amount", "price", "twitter:data1"])) ??
      toCents(html.match(/"price"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/)?.[1]);
  } catch {
    // best effort
  }
  return result;
}

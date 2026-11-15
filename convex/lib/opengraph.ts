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

export async function fetchOpenGraph(url: string): Promise<OpenGraph> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CartBot/0.1; +https://github.com/jykim16/mobilehack)",
      Accept: "text/html",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 500_000);
  const price = meta(html, "product:price:amount") ?? meta(html, "og:price:amount");
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  return {
    title: meta(html, "og:title") ?? titleTag,
    image: meta(html, "og:image"),
    description: meta(html, "og:description") ?? meta(html, "description"),
    siteName: meta(html, "og:site_name"),
    priceCents: price && !Number.isNaN(Number(price)) ? Math.round(Number(price) * 100) : undefined,
  };
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

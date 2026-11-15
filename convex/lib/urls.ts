export function retailerFromHost(host: string): { retailer: string; retailerName: string } {
  const h = host.replace(/^www\./, "").toLowerCase();
  if (h.includes("amazon.")) return { retailer: "amazon", retailerName: "Amazon" };
  if (h.includes("bestbuy.")) return { retailer: "bestbuy", retailerName: "Best Buy" };
  if (h.includes("target.")) return { retailer: "target", retailerName: "Target" };
  if (h.includes("walmart.")) return { retailer: "walmart", retailerName: "Walmart" };
  const name = h.split(".")[0] ?? h;
  return { retailer: name, retailerName: name.charAt(0).toUpperCase() + name.slice(1) };
}

export function canonicalKeyForUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const { retailer } = retailerFromHost(url.hostname);
  if (retailer === "amazon") {
    const m = url.pathname.match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})/i);
    if (m) return `amazon:${m[1].toUpperCase()}`;
  }
  if (retailer === "bestbuy") {
    const m = url.pathname.match(/\/(\d{7})\.p/) ?? url.search.match(/skuId=(\d{7})/);
    if (m) return `bestbuy:${m[1]}`;
  }
  return `${retailer}:${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`;
}

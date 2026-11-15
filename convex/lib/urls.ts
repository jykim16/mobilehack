type KnownRetailer = { retailer: string; retailerName: string; domains: string[] };

const KNOWN_RETAILERS: KnownRetailer[] = [
  {
    retailer: "amazon",
    retailerName: "Amazon",
    domains: ["amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.com.au", "amazon.co.jp"],
  },
  { retailer: "bestbuy", retailerName: "Best Buy", domains: ["bestbuy.com", "bestbuy.ca"] },
  { retailer: "target", retailerName: "Target", domains: ["target.com"] },
  { retailer: "walmart", retailerName: "Walmart", domains: ["walmart.com"] },
];

function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith("." + domain);
}

/** Only exact or subdomain matches count: amazon.attacker.example is not Amazon. */
function knownRetailer(hostname: string): KnownRetailer | null {
  const host = hostname.toLowerCase();
  return KNOWN_RETAILERS.find((r) => r.domains.some((d) => hostMatches(host, d))) ?? null;
}

export function retailerFromHost(hostname: string): { retailer: string; retailerName: string } {
  const known = knownRetailer(hostname);
  if (known) return { retailer: known.retailer, retailerName: known.retailerName };
  const label = hostname.replace(/^www\./, "").toLowerCase().split(".")[0] ?? hostname.toLowerCase();
  return { retailer: label, retailerName: label.charAt(0).toUpperCase() + label.slice(1) };
}

export function canonicalKeyForUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const known = knownRetailer(url.hostname);
  if (known?.retailer === "amazon") {
    const m = url.pathname.match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})/i);
    if (m) return `amazon:${m[1].toUpperCase()}`;
  }
  if (known?.retailer === "bestbuy") {
    const m = url.pathname.match(/\/(\d{7})\.p/) ?? url.search.match(/skuId=(\d{7})/);
    if (m) return `bestbuy:${m[1]}`;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  return `${known?.retailer ?? "web"}:${host}${url.pathname.replace(/\/$/, "")}`;
}

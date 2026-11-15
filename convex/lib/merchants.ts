export const MERCHANTS = [
  { domain: "amazon.com", name: "Amazon", returnDays: 30, freeReturns: true, summary: "Most items returnable within 30 days. Free returns on many items via UPS, Whole Foods, or Kohl's drop-off." },
  { domain: "target.com", name: "Target", returnDays: 90, freeReturns: true, summary: "90 days for most items (1 year for Target-owned brands). Free in-store or mail returns." },
  { domain: "nike.com", name: "Nike", returnDays: 60, freeReturns: true, summary: "60-day wear test for members. Free returns by mail or in store." },
  { domain: "apple.com", name: "Apple", returnDays: 14, freeReturns: true, summary: "14 days from delivery. Free returns in store or by mail; engraved items excluded." },
  { domain: "bestbuy.com", name: "Best Buy", returnDays: 15, freeReturns: true, summary: "15 days for most products (60 for Totaltech members). Some items carry a restocking fee." },
  { domain: "walmart.com", name: "Walmart", returnDays: 90, freeReturns: true, summary: "90 days for most items; electronics 30 days. Free returns in store or by mail." },
  { domain: "costco.com", name: "Costco", returnDays: 90, freeReturns: true, summary: "Risk-free satisfaction guarantee on most items; electronics 90 days." },
  { domain: "ikea.com", name: "IKEA", returnDays: 180, freeReturns: false, summary: "365 days for unopened items, 180 days opened. Mail returns may carry a fee." },
  { domain: "zara.com", name: "Zara", returnDays: 30, freeReturns: false, summary: "30 days. Free in store; mail returns cost a small fee." },
  { domain: "sephora.com", name: "Sephora", returnDays: 30, freeReturns: true, summary: "30 days for new or gently used products with receipt." },
  { domain: "rei.com", name: "REI", returnDays: 365, freeReturns: true, summary: "1 year for members, 90 days for others. Free returns." },
  { domain: "etsy.com", name: "Etsy", returnDays: 0, freeReturns: false, summary: "Set by each seller; many shops don't accept returns. Check the listing." },
];

export function merchantDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    return parts.slice(-2).join(".");
  } catch {
    return undefined;
  }
}

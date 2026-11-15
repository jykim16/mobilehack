import { listPurchases } from './cart-api';
import { catalog, HERO_URL } from './mock-catalog';
import type { Offer, Product, Rating } from './types';

/**
 * Canned shopping assistant. Not part of the backend contract yet; a real agent replaces
 * getChatHistory and sendChatMessage. Suggestions carry the product URL, which is what
 * api.cart.addItem takes.
 */

export interface ChatSuggestion {
  url: string;
  product: Product;
  offer: Offer;
  rating: Rating;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  suggestions?: ChatSuggestion[];
}

function suggestion(url: string): ChatSuggestion {
  for (const entry of catalog) {
    const offer = entry.offers.find((o) => o.url === url);
    if (offer) return { url, product: entry.product, offer, rating: entry.rating };
  }
  throw new Error(`Unknown product URL ${url}`);
}

const urlOf = (productId: string, retailer: string) =>
  catalog.find((e) => e.product.id === productId)!.offers.find((o) => o.retailer === retailer)!.url;

const SOUNDCORE = urlOf('soundcore-q45', 'amazon');
const AIRFLY = urlOf('airfly-pro', 'bestbuy');

let counter = 0;
const message = (role: ChatMessage['role'], text: string, suggestions?: ChatSuggestion[]): ChatMessage => ({
  id: `m${counter++}`,
  role,
  text,
  createdAt: Date.now(),
  suggestions,
});

let history: ChatMessage[] = [
  message('user', 'I need noise-cancelling headphones for flights. Anything good under $250?'),
  message(
    'assistant',
    "The Sony WH-1000XM5 just dropped from $279.99 to $229.99 at Amazon, which puts it at $249.00 with tax. It's the best noise cancelling I track. If you'd rather spend less, the Soundcore Space Q45 is $99.99.",
    [suggestion(HERO_URL), suggestion(SOUNDCORE)]
  ),
  message('user', 'Can I use them with the seatback screen?'),
  message(
    'assistant',
    'Yes, with the included cable. To go wireless, add the AirFly Pro. It plugs into the seat jack and pairs with your headphones. Best Buy has it for $49.99.',
    [suggestion(AIRFLY)]
  ),
];

const latency = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getChatHistory(): Promise<ChatMessage[]> {
  await latency(120);
  return history;
}

export async function sendChatMessage({ text }: { text: string }): Promise<ChatMessage[]> {
  history = [...history, message('user', text)];
  await latency(900);
  const reply = await cannedReply(text);
  history = [...history, message('assistant', reply.text, reply.suggestions)];
  return history;
}

async function cannedReply(text: string): Promise<{ text: string; suggestions?: ChatSuggestion[] }> {
  const q = text.toLowerCase();
  if (/(where|track|arriv|deliver|order|package)/.test(q)) {
    const open = (await listPurchases()).filter((p) => p.shipment && p.shipment.status !== 'delivered');
    if (open.length === 0) return { text: 'Everything you ordered has been delivered.' };
    const lines = open.map((p) => `${p.quote.productTitle.split(' ').slice(0, 3).join(' ')} from ${p.quote.retailerName}: ${statusPhrase(p.shipment!.status, p.shipment!.eta)}`);
    return { text: `Here's where things stand.\n\n${lines.join('\n')}` };
  }
  if (/(earbud|buds|airpod)/.test(q)) {
    return { text: 'The Galaxy Buds3 Pro are $179 at Walmart, the lowest price in 90 days.', suggestions: [suggestion(urlOf('galaxy-buds3-pro', 'walmart'))] };
  }
  if (/(headphone|noise|cancel)/.test(q)) {
    return { text: 'These two cover most budgets. Both are near their lowest prices this quarter.', suggestions: [suggestion(HERO_URL), suggestion(SOUNDCORE)] };
  }
  if (/(plane|flight|travel|airfly|seat)/.test(q)) {
    return { text: 'The AirFly Pro lets wireless headphones play from any seatback jack.', suggestions: [suggestion(AIRFLY)] };
  }
  if (/(shoe|run|sneaker|marathon)/.test(q)) {
    return {
      text: 'For daily miles, the Pegasus 41 is the safe pick. To track pace and heart rate too, the Forerunner 265 is $100 off at REI.',
      suggestions: [suggestion(urlOf('nike-pegasus-41', 'nike')), suggestion(urlOf('garmin-forerunner-265', 'rei'))],
    };
  }
  if (/(coffee|espresso)/.test(q)) {
    return { text: 'The Bambino Plus heats up in three seconds and steams milk on its own. Target has the best price.', suggestions: [suggestion(urlOf('breville-bambino-plus', 'target'))] };
  }
  if (/(deal|cheap|sale|discount|price|drop)/.test(q)) {
    return { text: 'The biggest drop I am tracking is the Sony WH-1000XM5, down $50 this week at Amazon.', suggestions: [suggestion(HERO_URL)] };
  }
  return { text: 'I compare prices across Amazon, Best Buy, Target, Walmart, REI, and Nike, combine their reviews into one rating, and track your orders. Try asking for running shoes or an espresso machine.' };
}

function statusPhrase(status: string, eta: string | null) {
  const day = eta ? new Date(`${eta}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' }) : 'soon';
  if (status === 'out_for_delivery') return 'out for delivery, arriving today';
  if (status === 'shipped') return `shipped, arriving ${day}`;
  return `order placed, arriving ${day}`;
}

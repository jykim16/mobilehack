"use node";

import { Supermemory } from "supermemory";

export function shopperNamespace(shopperId: string): string {
  const namespace = `user_${shopperId}`;
  if (!shopperId || namespace.length > 100 || /[^a-zA-Z0-9_:-]/.test(namespace)) {
    throw new Error("Invalid shopper ID for memory namespace");
  }
  return namespace;
}

export async function recallShopperMemories({
  shopperId,
  query,
  limit = 5,
}: {
  shopperId: string;
  query: string;
  limit?: number;
}): Promise<string[]> {
  const namespace = shopperNamespace(shopperId);
  if (!process.env.SUPERMEMORY_API_KEY || !query.trim() || !Number.isInteger(limit) || limit < 1) {
    return [];
  }
  const resultLimit = Math.min(limit, 10);
  try {
    const client = new Supermemory({ timeoutInSeconds: 5, maxRetries: 0 });
    const { results } = await client.search(namespace, {
      query,
      searchMode: "hybrid",
      limit: resultLimit,
    });
    return results
      .map((result) => (result.memory || result.chunk || "").trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, resultLimit);
  } catch {
    return [];
  }
}

export async function saveShopperExchange({
  shopperId,
  userText,
  assistantText,
  threadId,
}: {
  shopperId: string;
  userText: string;
  assistantText: string;
  threadId: string;
}): Promise<void> {
  const namespace = shopperNamespace(shopperId);
  if (!process.env.SUPERMEMORY_API_KEY || !userText.trim() || !assistantText.trim()) {
    return;
  }
  try {
    const client = new Supermemory({ timeoutInSeconds: 5, maxRetries: 0 });
    await client.add(namespace, {
      content: `User: ${userText}\nAssistant: ${assistantText}`,
      taskType: "memory",
      dreaming: "instant",
      metadata: { threadId },
    });
  } catch {
    return;
  }
}

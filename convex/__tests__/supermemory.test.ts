import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recallShopperMemories, saveShopperExchange, shopperNamespace } from "../supermemory";

const sdk = vi.hoisted(() => ({
  construct: vi.fn(),
  search: vi.fn(),
  add: vi.fn(),
}));

vi.mock("supermemory", () => ({
  Supermemory: class {
    constructor(options: unknown) {
      sdk.construct(options);
    }
    search = sdk.search;
    add = sdk.add;
  },
}));

const exchange = {
  shopperId: "alice",
  userText: "I prefer quiet keyboards.",
  assistantText: "I'll prioritize quiet switches.",
  threadId: "thread_1",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPERMEMORY_API_KEY", "unit-test-key");
  sdk.search.mockResolvedValue({ results: [] });
  sdk.add.mockResolvedValue({ id: "document_1", status: "queued" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shopperNamespace", () => {
  it("derives isolated namespaces without rewriting shopper IDs", () => {
    expect(shopperNamespace("alice")).toBe("user_alice");
    expect(shopperNamespace("bob")).toBe("user_bob");
    expect(shopperNamespace("Tenant:ALICE-123_4")).toBe("user_Tenant:ALICE-123_4");
    expect(shopperNamespace("a".repeat(95))).toHaveLength(100);
  });

  it.each(["", " ", "alice/bob", "alice@bob", "alice.bob", "alice\n", "üser", "a".repeat(96)])(
    "rejects invalid shopper ID %j",
    (shopperId) => {
      expect(() => shopperNamespace(shopperId)).toThrow("Invalid shopper ID");
    },
  );
});

describe("recallShopperMemories", () => {
  it("passes the namespace first to v5 search and returns bounded facts or snippets", async () => {
    sdk.search.mockResolvedValue({
      results: [
        { memory: " Prefers quiet keyboards. ", chunk: "Source text" },
        { chunk: "Asked about mechanical switches." },
        {},
        { memory: "x".repeat(600) },
        { memory: "Outside the requested limit" },
      ],
    });
    await expect(recallShopperMemories({ shopperId: "alice", query: "keyboards", limit: 3 })).resolves.toEqual([
      "Prefers quiet keyboards.",
      "Asked about mechanical switches.",
      "x".repeat(500),
    ]);
    expect(sdk.search).toHaveBeenCalledExactlyOnceWith("user_alice", {
      query: "keyboards",
      searchMode: "hybrid",
      limit: 3,
    });
    expect(sdk.construct).toHaveBeenCalledWith({ timeoutInSeconds: 5, maxRetries: 0 });
  });

  it("keeps searches for different shoppers isolated", async () => {
    await recallShopperMemories({ shopperId: "alice", query: "preferences" });
    await recallShopperMemories({ shopperId: "bob", query: "preferences" });
    expect(sdk.search.mock.calls.map(([namespace]) => namespace)).toEqual(["user_alice", "user_bob"]);
  });

  it("caps the number of requested memories", async () => {
    await recallShopperMemories({ shopperId: "alice", query: "preferences", limit: 100 });
    expect(sdk.search).toHaveBeenCalledWith("user_alice", expect.objectContaining({ limit: 10 }));
  });

  it("returns no context when the key is missing", async () => {
    vi.stubEnv("SUPERMEMORY_API_KEY", undefined);
    await expect(recallShopperMemories({ shopperId: "alice", query: "keyboards" })).resolves.toEqual([]);
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it("returns no context when search fails", async () => {
    sdk.search.mockRejectedValue(new Error("Service unavailable"));
    await expect(recallShopperMemories({ shopperId: "alice", query: "keyboards" })).resolves.toEqual([]);
  });

  it("skips empty queries and invalid limits", async () => {
    await recallShopperMemories({ shopperId: "alice", query: " " });
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
      await expect(recallShopperMemories({ shopperId: "alice", query: "keyboards", limit })).resolves.toEqual([]);
    }
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it("rejects invalid identities before calling the API", async () => {
    await expect(recallShopperMemories({ shopperId: "../bob", query: "preferences" })).rejects.toThrow();
    expect(sdk.construct).not.toHaveBeenCalled();
  });
});

describe("saveShopperExchange", () => {
  it("passes the namespace first to v5 add using the memory pipeline", async () => {
    await saveShopperExchange(exchange);
    expect(sdk.add).toHaveBeenCalledExactlyOnceWith("user_alice", {
      content: "User: I prefer quiet keyboards.\nAssistant: I'll prioritize quiet switches.",
      taskType: "memory",
      dreaming: "instant",
      metadata: { threadId: "thread_1" },
    });
  });

  it("does not use the thread ID as the isolation boundary", async () => {
    await saveShopperExchange(exchange);
    await saveShopperExchange({ ...exchange, shopperId: "bob" });
    expect(sdk.add.mock.calls.map(([namespace]) => namespace)).toEqual(["user_alice", "user_bob"]);
  });

  it("no-ops when the key is missing", async () => {
    vi.stubEnv("SUPERMEMORY_API_KEY", undefined);
    await expect(saveShopperExchange(exchange)).resolves.toBeUndefined();
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it("does not break the chat when ingestion fails", async () => {
    sdk.add.mockRejectedValue(new Error("Service unavailable"));
    await expect(saveShopperExchange(exchange)).resolves.toBeUndefined();
  });

  it("skips incomplete exchanges", async () => {
    await saveShopperExchange({ ...exchange, userText: " " });
    await saveShopperExchange({ ...exchange, assistantText: " " });
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it("rejects invalid identities before calling the API", async () => {
    await expect(saveShopperExchange({ ...exchange, shopperId: "alice/bob" })).rejects.toThrow();
    expect(sdk.construct).not.toHaveBeenCalled();
  });
});

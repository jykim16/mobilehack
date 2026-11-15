import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  agentCardValidator,
  amazonClientActionValidator,
  amazonSessionContextValidator,
  chatMessageRoleValidator,
  chatMessageStatusValidator,
  chatThreadStatusValidator,
} from "./validators";

export const chatAgentTables = {
  chatThreads: defineTable({
    shopperId: v.id("users"),
    status: chatThreadStatusValidator,
    activeClarificationId: v.optional(v.string()),
    pendingRequestId: v.optional(v.id("purchaseRequests")),
    lastError: v.optional(v.string()),
    amazonContext: v.optional(amazonSessionContextValidator),
    runSeq: v.number(),
    updatedAt: v.number(),
  }).index("by_shopperId_and_updatedAt", ["shopperId", "updatedAt"]),

  chatMessages: defineTable({
    threadId: v.id("chatThreads"),
    shopperId: v.id("users"),
    role: chatMessageRoleValidator,
    text: v.string(),
    cards: v.array(agentCardValidator),
    clientActions: v.optional(v.array(amazonClientActionValidator)),
    status: chatMessageStatusValidator,
    idempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_threadId_and_createdAt", ["threadId", "createdAt"])
    .index("by_threadId_and_idempotencyKey", ["threadId", "idempotencyKey"]),

  chatCheckpoints: defineTable({
    threadId: v.id("chatThreads"),
    checkpointNs: v.string(),
    checkpointId: v.string(),
    parentCheckpointId: v.optional(v.string()),
    checkpointSerdeType: v.string(),
    checkpointPayload: v.string(),
    metadataSerdeType: v.string(),
    metadataPayload: v.string(),
    createdAt: v.number(),
  })
    .index("by_thread_ns_and_checkpoint", ["threadId", "checkpointNs", "checkpointId"])
    .index("by_threadId", ["threadId"]),

  chatCheckpointWrites: defineTable({
    threadId: v.id("chatThreads"),
    checkpointNs: v.string(),
    checkpointId: v.string(),
    taskId: v.string(),
    idx: v.number(),
    channel: v.string(),
    serdeType: v.string(),
    payload: v.string(),
    taskPath: v.string(),
  })
    .index("by_thread_ns_and_checkpoint", ["threadId", "checkpointNs", "checkpointId"])
    .index("by_thread_ns_checkpoint_task_and_idx", [
      "threadId",
      "checkpointNs",
      "checkpointId",
      "taskId",
      "idx",
    ])
    .index("by_threadId", ["threadId"]),
};

"use node";

import { Command } from "@langchain/langgraph";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { buildCartAgentGraph } from "./graph";
import { formatDollars } from "./llm";
import { clarificationAnswersValidator } from "./validators";

export const runTurn = internalAction({
  args: {
    threadId: v.id("chatThreads"),
    runSeq: v.number(),
    mode: v.union(
      v.literal("new_message"),
      v.literal("resume_clarification"),
      v.literal("resume_clarification_freeform"),
      v.literal("message_during_approval"),
    ),
    userText: v.optional(v.string()),
    clarificationId: v.optional(v.string()),
    answers: v.optional(clarificationAnswersValidator),
    skipped: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const threadCtx = await ctx.runQuery(internal.chatAgent.internal.getThreadContext, {
      threadId: args.threadId,
    });
    if (!threadCtx) return null;

    const { thread } = threadCtx;
    const config = { configurable: { thread_id: args.threadId } };

    try {
      // Safety guard: free-form text while awaiting checkout approval NEVER approves an order.
      if (args.mode === "message_during_approval" && thread.pendingRequestId) {
        const text = args.userText ?? "";
        if (/\b(keep in cart|defer|hold off|cancel|not right now|wait|don't buy)\b/i.test(text)) {
          const deferRes = await ctx.runMutation(
            internal.chatAgent.internal.decidePurchaseForThread,
            {
              shopperId: thread.shopperId,
              threadId: args.threadId,
              requestId: thread.pendingRequestId,
              quoteVersion: 1,
              decision: "defer",
            },
          );
          const graph = buildCartAgentGraph({
            ctx,
            shopperId: thread.shopperId,
            threadId: args.threadId,
            amazonContext: thread.amazonContext,
          });
          await graph.invoke(
            new Command({
              resume: {
                decision: "defer",
                outcome: deferRes.outcome,
                requestId: thread.pendingRequestId,
              },
            }),
            config,
          );
          return null;
        }

        const pendingReq = await ctx.runQuery(internal.agent.getPurchaseStatus, {
          shopperId: thread.shopperId,
          requestId: thread.pendingRequestId,
        });
        const totalStr = pendingReq.quote
          ? formatDollars(pendingReq.quote.totalCents)
          : "the quoted total";

        await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
          threadId: args.threadId,
          text: `For your safety I never place an order from chat text alone—tap "Approve and buy" on the quote card (${totalStr}, quote v${pendingReq.quoteVersion}) or "Keep in Cart" to defer.`,
          cards: [],
          threadStatus: "awaiting_approval",
          pendingRequestId: thread.pendingRequestId,
          lastError: null,
          idempotencyKey: `msg_guard_${args.threadId}_${args.runSeq}`,
        });
        return null;
      }

      const graph = buildCartAgentGraph({
        ctx,
        shopperId: thread.shopperId,
        threadId: args.threadId,
        amazonContext: thread.amazonContext,
      });

      if (args.mode === "resume_clarification") {
        await graph.invoke(
          new Command({
            resume: args.skipped
              ? {
                  kind: "skipped",
                  clarificationId: args.clarificationId ?? "clar",
                  answers: args.answers,
                }
              : {
                  kind: "answered",
                  clarificationId: args.clarificationId ?? "clar",
                  answers: args.answers ?? {},
                },
          }),
          config,
        );
        return null;
      }

      if (args.mode === "resume_clarification_freeform") {
        await graph.invoke(
          new Command({
            resume: {
              kind: "freeform",
              clarificationId: args.clarificationId ?? "clar",
              text: args.userText ?? "",
            },
          }),
          config,
        );
        return null;
      }

      await graph.invoke(
        {
          userPrompt: args.userText ?? "",
          turnKey: `${args.threadId}_${args.runSeq}`,
          clarifiedInTurn: false,
        },
        config,
      );
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId: args.threadId,
        text: "Something went wrong while running that step. Try sending your request again.",
        cards: [],
        status: "error",
        threadStatus: "error",
        lastError: message.slice(0, 500),
        idempotencyKey: `msg_err_${args.threadId}_${args.runSeq}`,
      });
      return null;
    }
  },
});

export const resumeCheckout = internalAction({
  args: {
    threadId: v.id("chatThreads"),
    requestId: v.id("purchaseRequests"),
    decision: v.union(v.literal("approve"), v.literal("defer")),
    outcome: v.string(),
  },
  handler: async (ctx, args) => {
    const threadCtx = await ctx.runQuery(internal.chatAgent.internal.getThreadContext, {
      threadId: args.threadId,
    });
    if (!threadCtx) return null;

    const { thread } = threadCtx;
    const graph = buildCartAgentGraph({
      ctx,
      shopperId: thread.shopperId,
      threadId: args.threadId,
      amazonContext: thread.amazonContext,
    });

    await graph.invoke(
      new Command({
        resume: {
          decision: args.decision,
          outcome: args.outcome,
          requestId: args.requestId,
        },
      }),
      { configurable: { thread_id: args.threadId } },
    );
    return null;
  },
});

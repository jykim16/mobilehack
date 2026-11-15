import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type {
  AmazonClientAction,
  AmazonSessionContext,
  ChatMessage,
  ChatThreadStatus,
  CheckoutApprovalCard,
  ClarificationRequestCard,
  DecidePurchaseOutcome,
  PurchaseRequest,
} from "./types";

export type UseCartAgentChatOptions = {
  initialThreadId?: string | null;
  amazonContext?: AmazonSessionContext;
  autoCreateThread?: boolean;
  onClientAction?: (action: AmazonClientAction, messageId: string) => void | Promise<void>;
  onRequireAmazonSignIn?: (card: CheckoutApprovalCard) => boolean | Promise<boolean>;
};

export type UseCartAgentChatResult = {
  threadId: string | null;
  messages: ChatMessage[];
  threadStatus: ChatThreadStatus;
  isRunning: boolean;
  lastError: string | null;
  activeClarification: ClarificationRequestCard | null;
  pendingApproval: CheckoutApprovalCard | null;
  sendMessage: (text: string) => Promise<void>;
  submitClarification: (
    clarificationId: string,
    answers: Record<string, string | string[]>,
  ) => Promise<void>;
  skipClarification: (clarificationId: string) => Promise<void>;
  approveCheckout: (
    requestId: string,
    quoteVersion: number,
  ) => Promise<{ outcome: DecidePurchaseOutcome; request: PurchaseRequest } | void>;
  deferCheckout: (
    requestId: string,
    quoteVersion: number,
  ) => Promise<{ outcome: DecidePurchaseOutcome; request: PurchaseRequest } | void>;
  startNewThread: () => Promise<string>;
};

function makeIdempotencyKey(prefix: string): string {
  const uuid =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export function findActiveClarification(
  messages: ChatMessage[],
  activeClarificationId: string | null,
): ClarificationRequestCard | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    for (const card of msg.cards) {
      if (card.kind === "clarification_request" && card.status === "pending") {
        if (!activeClarificationId || card.clarificationId === activeClarificationId) {
          return card;
        }
      }
    }
  }
  return null;
}

export function findPendingApproval(
  messages: ChatMessage[],
  pendingRequestId: string | null,
  amazonStatus?: AmazonSessionContext["status"],
): CheckoutApprovalCard | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    for (const card of msg.cards) {
      if (card.kind === "checkout_approval" && card.status === "pending_approval") {
        if (!pendingRequestId || card.requestId === pendingRequestId) {
          const amazonSignInRequired =
            card.quote.retailer === "amazon"
              ? amazonStatus === "signed_out"
                ? true
                : amazonStatus === "connected"
                  ? false
                  : card.amazonSignInRequired
              : false;
          return {
            ...card,
            amazonSignInRequired,
          };
        }
      }
    }
  }
  return null;
}

export function useCartAgentChat(
  options?: UseCartAgentChatOptions,
): UseCartAgentChatResult {
  const { isAuthenticated } = useConvexAuth();
  const initialThreadId = options?.initialThreadId;
  const amazonContext = options?.amazonContext;
  const amazonStatus = amazonContext?.status;
  const autoCreateThread = options?.autoCreateThread ?? true;
  const onClientAction = options?.onClientAction;
  const onRequireAmazonSignIn = options?.onRequireAmazonSignIn;

  const [threadId, setThreadId] = useState<Id<"chatThreads"> | null>(
    initialThreadId ? (initialThreadId as Id<"chatThreads">) : null,
  );
  const [isActionPending, setIsActionPending] = useState(false);

  const creatingThreadPromise = useRef<Promise<Id<"chatThreads">> | null>(null);
  const dispatchedActionMessageIds = useRef<Set<string>>(new Set());
  const seededInitialHistory = useRef(false);

  const getOrCreateThreadMut = useMutation(api.chatAgent.api.getOrCreateThread);
  const createThreadMut = useMutation(api.chatAgent.api.createThread);
  const sendMessageMut = useMutation(api.chatAgent.api.sendMessage);
  const submitClarificationMut = useMutation(api.chatAgent.api.submitClarification);
  const decideCheckoutAct = useAction(api.chatAgent.api.decideCheckout);

  const ensureThread = useCallback(async (): Promise<Id<"chatThreads">> => {
    if (threadId) return threadId;
    if (creatingThreadPromise.current) return await creatingThreadPromise.current;

    const p = getOrCreateThreadMut({
      threadId: initialThreadId ? (initialThreadId as Id<"chatThreads">) : undefined,
    })
      .then((res) => {
        setThreadId(res.threadId);
        return res.threadId;
      })
      .finally(() => {
        creatingThreadPromise.current = null;
      });

    creatingThreadPromise.current = p;
    return await p;
  }, [getOrCreateThreadMut, initialThreadId, threadId]);

  useEffect(() => {
    if (!isAuthenticated || !autoCreateThread || threadId) return;
    void ensureThread();
  }, [autoCreateThread, ensureThread, isAuthenticated, threadId]);

  const threadState = useQuery(
    api.chatAgent.api.getThread,
    isAuthenticated && threadId ? { threadId } : "skip",
  );

  const rawMessages = useQuery(
    api.chatAgent.api.listMessages,
    isAuthenticated && threadId ? { threadId } : "skip",
  );

  const messages = useMemo<ChatMessage[]>(
    () => (rawMessages as ChatMessage[] | undefined) ?? [],
    [rawMessages],
  );

  // Dispatch newly arrived AmazonClientAction items exactly once per message ID.
  useEffect(() => {
    if (!rawMessages) return;
    if (!seededInitialHistory.current) {
      seededInitialHistory.current = true;
      for (const m of rawMessages) {
        dispatchedActionMessageIds.current.add(m.id);
      }
      return;
    }
    if (!onClientAction) return;

    for (const msg of rawMessages) {
      if (dispatchedActionMessageIds.current.has(msg.id)) continue;
      dispatchedActionMessageIds.current.add(msg.id);
      if (msg.clientActions && msg.clientActions.length > 0) {
        for (const action of msg.clientActions) {
          void onClientAction(action, msg.id);
        }
      }
    }
  }, [onClientAction, rawMessages]);

  const threadStatus: ChatThreadStatus = threadState?.status ?? "idle";
  const activeClarificationId = threadState?.activeClarificationId ?? null;
  const pendingRequestId = threadState?.pendingRequestId ?? null;
  const isRunning = threadStatus === "running" || isActionPending;
  const lastError = threadState?.lastError ?? null;

  const activeClarification = useMemo(
    () => findActiveClarification(messages, activeClarificationId),
    [activeClarificationId, messages],
  );

  const pendingApproval = useMemo(
    () => findPendingApproval(messages, pendingRequestId, amazonStatus),
    [amazonStatus, messages, pendingRequestId],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const activeThreadId = await ensureThread();
      await sendMessageMut({
        threadId: activeThreadId,
        text: trimmed,
        idempotencyKey: makeIdempotencyKey("msg"),
        amazonContext,
      });
    },
    [amazonContext, ensureThread, sendMessageMut],
  );

  const submitClarification = useCallback(
    async (clarificationId: string, answers: Record<string, string | string[]>) => {
      const activeThreadId = await ensureThread();
      await submitClarificationMut({
        threadId: activeThreadId,
        clarificationId,
        answers,
        skipped: false,
      });
    },
    [ensureThread, submitClarificationMut],
  );

  const skipClarification = useCallback(
    async (clarificationId: string) => {
      const activeThreadId = await ensureThread();
      await submitClarificationMut({
        threadId: activeThreadId,
        clarificationId,
        answers: {},
        skipped: true,
      });
    },
    [ensureThread, submitClarificationMut],
  );

  const approveCheckout = useCallback(
    async (requestId: string, quoteVersion: number) => {
      const activeThreadId = await ensureThread();
      if (pendingApproval && pendingApproval.requestId === requestId && pendingApproval.amazonSignInRequired) {
        if (onRequireAmazonSignIn) {
          const signedIn = await onRequireAmazonSignIn(pendingApproval);
          if (!signedIn) return;
        }
      }

      setIsActionPending(true);
      try {
        const res = await decideCheckoutAct({
          threadId: activeThreadId,
          requestId: requestId as Id<"purchaseRequests">,
          quoteVersion,
          decision: "approve",
        });
        return res as { outcome: DecidePurchaseOutcome; request: PurchaseRequest };
      } finally {
        setIsActionPending(false);
      }
    },
    [decideCheckoutAct, ensureThread, onRequireAmazonSignIn, pendingApproval],
  );

  const deferCheckout = useCallback(
    async (requestId: string, quoteVersion: number) => {
      const activeThreadId = await ensureThread();
      setIsActionPending(true);
      try {
        const res = await decideCheckoutAct({
          threadId: activeThreadId,
          requestId: requestId as Id<"purchaseRequests">,
          quoteVersion,
          decision: "defer",
        });
        return res as { outcome: DecidePurchaseOutcome; request: PurchaseRequest };
      } finally {
        setIsActionPending(false);
      }
    },
    [decideCheckoutAct, ensureThread],
  );

  const startNewThread = useCallback(async (): Promise<string> => {
    const res = await createThreadMut({});
    seededInitialHistory.current = true;
    setThreadId(res.threadId);
    return res.threadId;
  }, [createThreadMut]);

  return {
    threadId,
    messages,
    threadStatus,
    isRunning,
    lastError,
    activeClarification,
    pendingApproval,
    sendMessage,
    submitClarification,
    skipClarification,
    approveCheckout,
    deferCheckout,
    startNewThread,
  };
}

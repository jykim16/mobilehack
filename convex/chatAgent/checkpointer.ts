"use node";

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  writesSortKey,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

type StoredCheckpointRow = {
  checkpointId: string;
  checkpointNs: string;
  parentCheckpointId?: string;
  checkpointSerdeType: string;
  checkpointPayload: string;
  metadataSerdeType: string;
  metadataPayload: string;
};

type StoredWriteRow = {
  taskId: string;
  idx: number;
  channel: string;
  serdeType: string;
  payload: string;
  taskPath: string;
};

const decoder = new TextDecoder();

export class ConvexCheckpointSaver extends BaseCheckpointSaver {
  private readonly ctx: ActionCtx;

  constructor(ctx: ActionCtx) {
    super();
    this.ctx = ctx;
  }

  private resolveThreadId(config: RunnableConfig): Id<"chatThreads"> | undefined {
    const raw = config.configurable?.thread_id;
    return typeof raw === "string" && raw.length > 0 ? (raw as Id<"chatThreads">) : undefined;
  }

  private async deserializeWrites(writes: StoredWriteRow[]): Promise<CheckpointPendingWrite[]> {
    const sorted = [...writes]
      .map((w) => ({
        key: writesSortKey(w.taskPath ?? "", w.taskId, w.idx),
        row: w,
      }))
      .sort((a, b) => compareWritesSortKeys(a.key, b.key));

    return await Promise.all(
      sorted.map(async ({ row }) => [
        row.taskId,
        row.channel,
        await this.serde.loadsTyped(row.serdeType, row.payload),
      ]),
    );
  }

  private async hydrateTuple(
    threadId: Id<"chatThreads">,
    row: StoredCheckpointRow,
    writes: StoredWriteRow[],
    inputConfig?: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const deserializedCheckpoint = (await this.serde.loadsTyped(
      row.checkpointSerdeType,
      row.checkpointPayload,
    )) as Checkpoint;

    if (deserializedCheckpoint.v < 4 && row.parentCheckpointId !== undefined) {
      const parentTuple: {
        checkpoint: StoredCheckpointRow;
        writes: StoredWriteRow[];
      } | null = await this.ctx.runQuery(internal.chatAgent.internal.getCheckpointTuple, {
        threadId,
        checkpointNs: row.checkpointNs,
        checkpointId: row.parentCheckpointId,
      });
      if (parentTuple) {
        const pendingSends = await Promise.all(
          parentTuple.writes
            .filter((w: StoredWriteRow) => w.channel === TASKS)
            .map((w: StoredWriteRow) => this.serde.loadsTyped(w.serdeType, w.payload)),
        );
        deserializedCheckpoint.channel_values ??= {};
        deserializedCheckpoint.channel_values[TASKS] = pendingSends;
        deserializedCheckpoint.channel_versions ??= {};
        const existingVersions = Object.values(deserializedCheckpoint.channel_versions);
        deserializedCheckpoint.channel_versions[TASKS] =
          existingVersions.length > 0
            ? maxChannelVersion(...existingVersions)
            : this.getNextVersion(undefined);
      }
    }

    const metadata = (await this.serde.loadsTyped(
      row.metadataSerdeType,
      row.metadataPayload,
    )) as CheckpointMetadata;
    const pendingWrites = await this.deserializeWrites(writes);

    const tuple: CheckpointTuple = {
      config:
        inputConfig && getCheckpointId(inputConfig)
          ? inputConfig
          : {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: row.checkpointNs,
                checkpoint_id: row.checkpointId,
              },
            },
      checkpoint: deserializedCheckpoint,
      metadata,
      pendingWrites,
    };

    if (row.parentCheckpointId !== undefined) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: row.checkpointNs,
          checkpoint_id: row.parentCheckpointId,
        },
      };
    }

    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = this.resolveThreadId(config);
    if (!threadId) return undefined;
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = getCheckpointId(config);

    const found = await this.ctx.runQuery(internal.chatAgent.internal.getCheckpointTuple, {
      threadId,
      checkpointNs,
      checkpointId: checkpointId || undefined,
    });
    if (!found) return undefined;

    return await this.hydrateTuple(threadId, found.checkpoint, found.writes, config);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = this.resolveThreadId(config);
    if (!threadId) return;

    const checkpointNs = config.configurable?.checkpoint_ns as string | undefined;
    const checkpointId = getCheckpointId(config);
    const beforeCheckpointId = options?.before ? getCheckpointId(options.before) : undefined;

    const rows = await this.ctx.runQuery(internal.chatAgent.internal.listCheckpointTuples, {
      threadId,
      checkpointNs,
      checkpointId: checkpointId || undefined,
      beforeCheckpointId: beforeCheckpointId || undefined,
      limit: options?.limit,
    });

    let remaining = options?.limit;
    for (const entry of rows) {
      const tuple = await this.hydrateTuple(threadId, entry.checkpoint, entry.writes);
      if (options?.filter && tuple.metadata) {
        const metaRecord = tuple.metadata as Record<string, unknown>;
        const matches = Object.entries(options.filter).every(([k, val]) => metaRecord[k] === val);
        if (!matches) continue;
      }
      if (remaining !== undefined) {
        if (remaining <= 0) break;
        remaining -= 1;
      }
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = this.resolveThreadId(config);
    if (!threadId) {
      throw new Error('ConvexCheckpointSaver.put requires configurable.thread_id.');
    }
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const prepared = copyCheckpoint(checkpoint);

    const [[checkpointSerdeType, cpBytes], [metadataSerdeType, metaBytes]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ]);

    const parentCheckpointId = config.configurable?.checkpoint_id as string | undefined;

    await this.ctx.runMutation(internal.chatAgent.internal.putCheckpoint, {
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: parentCheckpointId || undefined,
      checkpointSerdeType,
      checkpointPayload: decoder.decode(cpBytes),
      metadataSerdeType,
      metadataPayload: decoder.decode(metaBytes),
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    const threadId = this.resolveThreadId(config);
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!threadId || !checkpointId) {
      throw new Error(
        "ConvexCheckpointSaver.putWrites requires configurable.thread_id and configurable.checkpoint_id.",
      );
    }

    const serializedWrites = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [serdeType, bytes] = await this.serde.dumpsTyped(value);
        const mappedIdx =
          Object.prototype.hasOwnProperty.call(WRITES_IDX_MAP, channel)
            ? WRITES_IDX_MAP[channel]
            : idx;
        return {
          taskId,
          idx: mappedIdx,
          channel,
          serdeType,
          payload: decoder.decode(bytes),
          taskPath: taskPath ?? "",
        };
      }),
    );

    await this.ctx.runMutation(internal.chatAgent.internal.putCheckpointWrites, {
      threadId,
      checkpointNs,
      checkpointId,
      writes: serializedWrites,
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ctx.runMutation(internal.chatAgent.internal.deleteThreadCheckpoints, {
      threadId: threadId as Id<"chatThreads">,
    });
  }
}

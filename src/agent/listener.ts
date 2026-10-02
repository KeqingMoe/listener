import { isExecutionDiagnostic } from '../sandbox/protocol.ts';
import { buildSystemPrompt } from './prompts/index.ts';
import { presentTools, toolSchemaMode } from './tool-declarations/index.ts';
import {
  buildToolDefinitions,
  SANDBOX_EXCLUDED_TOOLS,
} from './tool-definitions.ts';
import { SideEffectPacer } from './pacing.ts';
import { imagePixelsOf } from './image-pixels.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { logToolResult } from './tool-result-log.ts';
import { withSentEntries } from './wake-memory.ts';
import {
  VIEWED_IMAGES_NOTICE,
  confirmationNotice,
  type WakeFlags,
} from './wake-shared.ts';
import { WakeManagement } from './wake-management.ts';
import { WakeExtended } from './wake-extended.ts';
import { WakeSend } from './wake-send.ts';
import { GroupSender } from './group-sender.ts';
import type { CustomFaceRuntime, ListenerRuntime } from './runtime-types.ts';
import { proposeExtended } from './extended-confirmation.ts';
import {
  newTurnStats,
  silentOutcome,
  cancelledOutcome,
  turnStatsFields,
  countReaction,
} from './turn-outcome.ts';
import { createTurnToolkit, type TurnToolkitOptions } from './turn-toolkit.ts';
import { normalizeEvent } from './normalize-event.ts';

export { normalizeEvent };
import { applyToolPolicies, observesReactions } from '../config/runtime.ts';
import { TOOL_NAMES } from '../config/tool-policy.ts';
import { canonicalMessageId, id } from '../onebot/identity.ts';
import { resolveGroupId, resolveOwnerId } from '../contracts/identity.ts';
import { type Api } from '../contracts/onebot.ts';
import { type Model, type ChatContentPart } from '../contracts/model.ts';
import { type Memory, type TimelineEntry } from '../contracts/messages.ts';
import { type TurnContext, type ToolDefinition } from '../contracts/tools.ts';
import { type JsonObject, isObject } from '../contracts/json.ts';
import {
  Moderation,
  MODERATION_TOOLS,
  buildModerationTools,
} from '../tools/management/moderation.ts';
import type {
  ListenerConfig,
  ProjectedListenerConfig,
} from '../config/listener.ts';
import { GROUP_TOOLS, type PreparedMessage } from '../tools/messaging/tools.ts';
import { type ImageTools } from '../tools/images/tools.ts';
import type { ImageDownloader } from '../tools/images/download.ts';
import { log, withLogContext, newTraceId } from '../observability/logger.ts';
import { ModelError } from '../model/chat.ts';
import { OneBotError } from '../onebot/client.ts';
import {
  DuplicateMessageAckError,
  writeFailure,
} from '../onebot/operation-result.ts';

import { ReplyBatch, type BatchItem } from './reply-batch.ts';
import type { TurnAdmission } from './scheduler.ts';
import {
  AttentionEngine,
  type AttentionHit,
  type AttentionTransaction,
} from './attention.ts';
import { ReactionObservations } from '../world/reaction-observations.ts';
import { annotateReactionReadResult } from './reaction-presentation.ts';
import { normalizeOneBotEvent } from '../world/ingest.ts';

import type { ModelSessionScope } from './session/store.ts';
import { WorldTools, WORLD_TOOL_NAMES } from '../tools/world/tools.ts';
import {
  ResponsesModel,
  ResponseStateExpiredError,
} from '../model/responses.ts';
import {
  EXTENDED_TOOL_NAMES,
  enabledExtendedTools,
} from '../config/extended-tools.ts';
import { GroupFileTools, GROUP_FILE_TOOL_NAMES } from '../tools/files/tools.ts';
import {
  GroupRequestTools,
  GROUP_REQUEST_TOOL_NAMES,
} from '../tools/requests/tools.ts';
import { CUSTOM_FACE_TOOL_NAMES } from '../tools/custom-faces/tools.ts';
import { CustomFaceStore } from '../tools/custom-faces/store.ts';
import { CustomFaceCoordinator } from '../tools/custom-faces/coordinator.ts';
import type { Reminder, DeliveryOutcome } from '../reminders/store.ts';

function keys(value: JsonObject, allowed: string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k));
}

/**
 * 单群AI监听器：接收OneBot事件、维护未读与回复批次、按@/引用/关注/随机触发调度turn，
 * 驱动模型工具循环，并向沙箱代码暴露同一套工具实现。
 */
export class Listener {
  private moderation: Moderation;
  private readonly sender: GroupSender;
  private readonly groupId: string;
  private readonly ownerId: string;
  private admission?: AbortController;
  private readonly attention?: AttentionEngine;
  private attentionTimer?: NodeJS.Timeout;
  private readonly unread = new Map<number, BatchItem>();
  private unreadOmitted = 0;
  private readonly reactionObservations?: ReactionObservations;
  private arrivalSequence = 0;
  private lastSealedSequence = 0;
  private generation = 0;
  private pending?: ReplyBatch;
  private sandboxSelfId?: string;
  private hostWakeId = newTraceId();
  private hasHostWork(): boolean {
    return (
      !!this.sandboxSelfId &&
      this.runtime.session.hasExternalEvents(this.sandboxSelfId)
    );
  }

  private resolving = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private active?: AbortController;
  private activeCancelReason?: string;
  private running = false;
  private stopped = false;
  private connected = true;
  private lastTurn = 0;
  private reads = 0;
  private commandCooldown = 0;
  private commandBusy = false;

  private worldTools?: WorldTools;
  private readonly groupFiles: GroupFileTools;
  private readonly groupRequests: GroupRequestTools;
  private readonly customFaces?: CustomFaceRuntime;
  private readonly ownsCustomFaces: boolean;
  private readonly worldMessageSequences = new Map<string, number>();
  private worldWake: JsonObject = {};
  private worldBudget: () => JsonObject = () => ({});
  private lastRandomAt = -Infinity;
  private randomAttempts: number[] = [];
  private readonly config: ProjectedListenerConfig;
  constructor(
    private api: Api,
    private model: Model | undefined,
    private memory: Memory | undefined,
    input: ListenerConfig,
    private random: () => number = Math.random,
    private imageDownloader: ImageDownloader | undefined,
    private turnScheduler: TurnAdmission | undefined,
    private runtime: ListenerRuntime,
  ) {
    for (const [key, min, max] of [
      ['maxToolCallsPerWake', 1, Number.MAX_SAFE_INTEGER],
      ['wakeTimeoutMs', 1000, 600000],
    ] as const) {
      const value = input[key];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < min || value > max)
      ) {
        throw new Error('Invalid wake budget configuration');
      }
    }
    const config = applyToolPolicies(input);
    this.config = structuredClone(config);
    this.groupId = resolveGroupId(config.groupId);
    this.ownerId = resolveOwnerId(this.config.ownerId);
    this.config.ownerId = this.ownerId;
    const enabled = new Set<string>(
      enabledExtendedTools(this.config.tools.extended),
    );
    this.groupFiles = new GroupFileTools(
      api,
      this.groupId,
      GROUP_FILE_TOOL_NAMES.filter((name) => enabled.has(name)),
      { artifacts: runtime.artifacts },
    );
    this.groupRequests = new GroupRequestTools(
      api,
      this.groupId,
      GROUP_REQUEST_TOOL_NAMES.filter((name) => enabled.has(name)),
    );
    if (runtime.world.groupId !== this.groupId) {
      throw new Error('World group mismatch');
    }
    this.ownsCustomFaces =
      !runtime.customFaces &&
      CUSTOM_FACE_TOOL_NAMES.some((name) => enabled.has(name));
    this.customFaces =
      runtime.customFaces ??
      (this.ownsCustomFaces
        ? {
            store: new CustomFaceStore(),
            coordinator: new CustomFaceCoordinator(),
          }
        : undefined);
    if (config.attention.enabled && config.enabled && model && memory) {
      this.attention = new AttentionEngine(config.attention, random);
    }
    if (observesReactions(config) && config.enabled && model && memory) {
      this.reactionObservations = new ReactionObservations(
        api,
        this.groupId,
        config.retentionDays,
      );
    }
    this.moderation = new Moderation(
      api,
      Date.now,
      config.tools.moderation,
      this.groupId,
      this.ownerId,
    );
    this.sender = new GroupSender({
      api,
      groupId: this.groupId,
      botName: this.config.botName,
      world: runtime.world,
      memory: () => this.memory,
      generation: () => this.generation,
      live: () => this.connected && !this.stopped,
      remindersEnabled: () =>
        this.config.tools.extended?.create_reminder === 'direct',
    });
  }

  /** 由提醒调度器调用；与模型发送共用同一发送队列。 */
  sendReminder(
    reminder: Reminder,
    claim: () => boolean,
  ): Promise<DeliveryOutcome> {
    return this.sender.sendReminder(reminder, claim);
  }

  private clearEphemeralState(): void {
    this.groupFiles.reset();
    this.groupRequests.reset();
    clearTimeout(this.attentionTimer);
    this.attentionTimer = undefined;
    this.attention?.clear();
    this.unread.clear();
    this.unreadOmitted = 0;
    this.reactionObservations?.clear();
  }

  private unreadItems(): BatchItem[] {
    return [...this.unread.values()]
      .filter((item) => !this.resolving.has(item.entry.messageId))
      .sort((a, b) => a.sequence - b.sequence);
  }

  private rememberUnread(item: BatchItem): void {
    if (!this.attention) {
      return;
    }
    this.unread.set(item.sequence, item);
    if (this.unread.size > 128) {
      this.unread.delete(Math.min(...this.unread.keys()));
      this.unreadOmitted++;
    }
  }

  private armAttention(): void {
    clearTimeout(this.attentionTimer);
    this.attentionTimer = undefined;
    if (!this.attention || this.stopped || !this.connected) {
      return;
    }
    const now = Date.now(),
      deadline = this.attention.nextDeadline(now);
    if (deadline !== undefined) {
      this.attentionTimer = setTimeout(
        () => {
          this.attentionTimer = undefined;
          this.wakeAttention(
            this.attention!.evaluate(Date.now(), this.unreadItems().length > 0),
          );
          this.armAttention();
        },
        Math.max(1, deadline - now),
      );
    }
  }

  private wakeAttention(hits: AttentionHit[]): void {
    if (!hits.length || this.stopped || !this.connected) {
      return;
    }
    const unread = this.unreadItems();
    if (!unread.length) {
      return;
    }
    if (!this.pending) {
      this.pending = new ReplyBatch(
        unread[unread.length - 1]!,
        0,
        false,
        this.ownerId,
      );
    }
    const wasDirect = this.pending.kind === 'direct';
    for (const item of unread) {
      this.pending.add(item, 0);
    }
    this.pending.addAttention(hits);
    if (!wasDirect) {
      this.pending.readyAt = Math.min(this.pending.readyAt, Date.now());
    }
    log('info', 'attention.wake', {
      group_id: this.groupId,
      turn_id: this.pending.turnId,
      actor_id: this.pending.primary.context.actorId,
      message_id: this.pending.primary.entry.messageId,
      count: hits.length,
    });
    clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule();
  }

  private resetModeration(): void {
    this.moderation.dispose();
    this.moderation = new Moderation(
      this.api,
      Date.now,
      this.config.tools.moderation,
      this.groupId,
      this.ownerId,
    );
  }

  private cancelActive(reason: string): void {
    // 保留第一次取消的原因，即使wake过期之后又发生shutdown。
    if (this.active && !this.active.signal.aborted) {
      this.activeCancelReason = reason;
      this.active.abort(reason);
    }
    if (this.admission && !this.admission.signal.aborted) {
      this.admission.abort(reason);
    }
  }

  private acknowledgeObserved(through: number): void {
    const acknowledged = (messageId: string) => {
      const sequence = this.worldMessageSequences.get(messageId);
      return sequence !== undefined && sequence <= through;
    };
    for (const [key, item] of this.unread) {
      if (acknowledged(item.entry.messageId)) {
        this.unread.delete(key);
      }
    }
    const pending = this.pending;
    // 有溢出时不丢弃批次：被省略的触发消息可能还没被处理到。
    if (
      pending &&
      !pending.omittedMessages &&
      !pending.omittedDirect &&
      pending.items.every((item) => acknowledged(item.entry.messageId))
    ) {
      this.dropPending('observed_by_active_wake');
    }
  }

  private dropPending(reason: string): void {
    if (this.pending) {
      log('info', 'trigger.dropped', {
        turn_id: this.pending.turnId,
        group_id: this.groupId,
        actor_id: this.pending.primary.context.actorId,
        message_id: this.pending.primary.entry.messageId,
        count: this.pending.items.length,
        reason,
      });
    }
    this.pending = undefined;
  }

  async receiveSandboxResult(result: {
    selfId: string;
    groupId: string;
    jobId: string;
    [key: string]: unknown;
  }): Promise<boolean> {
    if (
      result.groupId !== this.groupId ||
      (this.sandboxSelfId !== undefined &&
        result.selfId !== this.sandboxSelfId) ||
      this.stopped ||
      !this.connected ||
      !this.config.enabled
    ) {
      throw new Error('sandbox_delivery_unavailable');
    }
    this.sandboxSelfId = result.selfId;
    const eventId = `${result.selfId}:${result.jobId}`;
    this.runtime.session.receiveExternalEvent(eventId, result.selfId, {
      job_id: result.jobId,
      description:
        typeof result.description === 'string'
          ? result.description.slice(0, 1024)
          : '',
      status: result.status,
      ...(typeof result.value === 'string' ? { value: result.value } : {}),
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
      ...(isExecutionDiagnostic(result.diagnostic)
        ? { diagnostic: { ...result.diagnostic } }
        : {}),
      ...(isObject(result.toolCalls)
        ? { tool_calls: structuredClone(result.toolCalls) }
        : {}),
      finished_at:
        typeof result.finishedAt === 'number' ? result.finishedAt : Date.now(),
    });
    this.schedule();
    return this.runtime.session.externalEventProjected(eventId, result.selfId);
  }

  /** 使进行中的turn与未决工作全部失效：取消调度、丢弃未读、清空确认与临时状态。 */
  private interrupt(reason: string): void {
    this.generation++;
    this.cancelActive(reason);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dropPending(reason);
    this.resolving.clear();
    this.resetModeration();
    this.clearEphemeralState();
  }

  setConnected(value: boolean): void {
    this.connected = value;
    if (!value) {
      this.interrupt('disconnected');
    }
  }

  async receive(event: unknown, selfId: string): Promise<void> {
    if (this.stopped || !this.connected) {
      return;
    }
    const worldInput = normalizeOneBotEvent(event, selfId, 'onebot');
    if (worldInput) {
      try {
        const stored = this.runtime.world.append(worldInput);
        if (stored.payload.kind === 'message') {
          this.worldMessageSequences.set(
            stored.payload.message.messageId,
            stored.sequence,
          );
          if (this.worldMessageSequences.size > 512) {
            this.worldMessageSequences.delete(
              this.worldMessageSequences.keys().next().value!,
            );
          }
        }
      } catch {
        log('warn', 'message.world_store_failed', {
          reason: 'storage_failed',
        });
        return;
      }
    }
    if (isObject(event) && event.post_type === 'notice') {
      if (this.memory) {
        this.reactionObservations?.notice(event, this.memory);
      }
      return; // notice类元数据更新不进入聊天记忆、未读缓冲或触发判断。
    }
    const entry = normalizeEvent(event, selfId, this.groupId);
    if (!entry) {
      return;
    }
    // 重连后不重放历史消息，也不接受时间戳远在未来的事件。
    if (Math.abs(Date.now() / 1000 - entry.time) > 120) {
      log('debug', 'message.skipped', {
        message_id: entry.messageId,
        reason: 'stale_timestamp',
      });
      return;
    }
    log('debug', 'message.received', {
      group_id: this.groupId,
      actor_id: entry.userId,
      message_id: entry.messageId,
      images: entry.images?.length ?? 0,
    });
    const context: TurnContext = {
      groupId: this.groupId,
      actorId: entry.userId,
      messageId: entry.messageId,
      selfId,
    };
    // 只有显式启用AI时才有memory；未启用时不收集群聊历史。
    if (this.memory && !this.memory.append(entry)) {
      log('debug', 'message.skipped', {
        message_id: entry.messageId,
        reason: 'duplicate_or_rejected',
      });
      return;
    }
    const sequence = ++this.arrivalSequence;
    const generation = this.generation;
    const received = Date.now();
    const arrivedBusy = this.running || !!this.pending;
    // normalizeEvent已确认message是数组，这里只读取文字与at片段。
    const raw = (event as { message: Array<JsonObject | null> }).message;
    const data = (s: JsonObject | null): JsonObject | undefined =>
      s && typeof s.data === 'object' && s.data && !Array.isArray(s.data)
        ? (s.data as JsonObject)
        : undefined;
    const commandText = raw
      .filter((s) => s?.type === 'text')
      .map((s) => {
        const text = data(s)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('')
      .trim();
    const onlyCommandSegments = raw.every(
      (s) =>
        s?.type === 'text' || (s?.type === 'at' && id(data(s)?.qq) === selfId),
    );
    if (onlyCommandSegments && /^\/(reset|confirm)(?:\s|$)/.test(commandText)) {
      await withLogContext(
        {
          command_id: newTraceId('c'),
          group_id: context.groupId,
          actor_id: context.actorId,
          message_id: context.messageId,
        },
        () => this.command(commandText, context),
      );
      return;
    }
    if (!this.model || !this.memory || !this.config.enabled) {
      log('debug', 'trigger.skipped', {
        message_id: entry.messageId,
        reason: this.config.enabled ? 'listener_unavailable' : 'group_disabled',
      });
      return;
    }
    const attentionEligible =
      !!this.attention && !!entry.text.trim() && !commandText.startsWith('/');
    if (attentionEligible) {
      this.rememberUnread({
        entry,
        context,
        sequence,
        received,
        ...(entry.replyTo ? { unverifiedQuote: true } : {}),
      });
    }
    let triggered =
      this.config.mentionEnabled !== false &&
      raw.some((s) => s?.type === 'at' && id(data(s)?.qq) === selfId);
    const mentioned = triggered;
    let unverifiedQuote = false;
    if (
      !triggered &&
      this.config.quoteBotEnabled !== false &&
      entry.replyTo !== undefined
    ) {
      const local = this.memory.find(entry.replyTo);
      if (local) {
        triggered = local.bot === true && local.userId === selfId;
      } else if (this.reads < 2) {
        unverifiedQuote = true;
        this.reads++;
        this.resolving.set(entry.messageId, generation);
        try {
          const ref = await this.api.call('get_msg', {
            message_id: entry.replyTo,
          });
          if (
            isObject(ref) &&
            id(ref.group_id) === this.groupId &&
            ref.message_type === 'group' &&
            canonicalMessageId(ref.message_id) === entry.replyTo &&
            isObject(ref.sender) &&
            id(ref.sender.user_id)
          ) {
            triggered = id(ref.sender.user_id) === selfId;
            unverifiedQuote = false;
          }
        } catch {
          log('debug', 'trigger.reference_failed', {
            message_id: entry.messageId,
            reason: 'lookup_failed',
          });
        } finally {
          this.reads--;
          if (this.resolving.get(entry.messageId) === generation) {
            this.resolving.delete(entry.messageId);
          }
        }
      } else {
        unverifiedQuote = true;
        log('warn', 'trigger.reference_failed', {
          message_id: entry.messageId,
          reason: 'lookup_busy',
        });
      }
    }
    if (this.stopped || !this.connected || generation !== this.generation) {
      return;
    }
    if (!triggered && (!entry.text.trim() || commandText.startsWith('/'))) {
      return;
    }
    const item: BatchItem = {
      entry,
      context,
      sequence,
      received,
      ...(unverifiedQuote ? { unverifiedQuote: true } : {}),
      ...(triggered
        ? { trigger: mentioned ? ('mention' as const) : ('quote' as const) }
        : {}),
    };
    let attentionHits: AttentionHit[] = [];
    if (attentionEligible) {
      this.rememberUnread(item);
      this.attention!.observe({ sequence, received, userId: entry.userId });
      attentionHits = this.attention!.evaluate(
        Date.now(),
        this.unreadItems().length > 0,
      );
      this.armAttention();
    }
    // 迟到的引用查询结果不能重新抽取随机批次；但匹配的显式关注计划
    // 仍可处理此前未解析引用的未读消息。
    if (
      !triggered &&
      !attentionHits.length &&
      (sequence <= this.lastSealedSequence ||
        (arrivedBusy && !this.running && !this.pending))
    ) {
      return;
    }
    if (!this.pending) {
      let selected = false;
      if (!triggered && !attentionHits.length && !this.running) {
        if (this.commandBusy || !this.selectRandom(entry.messageId)) {
          return;
        }
        selected = true;
      }
      this.pending = new ReplyBatch(
        item,
        triggered || selected
          ? this.replyDelay()
          : attentionHits.length
            ? 0
            : this.config.debounceMs,
        selected,
        this.ownerId,
      );
      log('info', 'trigger.accepted', {
        turn_id: this.pending.turnId,
        group_id: context.groupId,
        actor_id: context.actorId,
        message_id: context.messageId,
        trigger:
          item.trigger ?? (attentionHits.length ? 'attention' : 'random'),
        wait_ms: Math.max(0, this.pending.readyAt - Date.now()),
      });
    } else {
      const before = this.pending.omittedMessages;
      const wasDirect = this.pending.kind === 'direct';
      this.pending.add(
        item,
        triggered
          ? wasDirect
            ? Math.max(
                0,
                this.pending.readyAt - this.pending.direct[0]!.received,
              )
            : this.replyDelay()
          : 0,
      );
      log(triggered ? 'info' : 'debug', 'trigger.merged', {
        turn_id: this.pending.turnId,
        actor_id: context.actorId,
        message_id: entry.messageId,
        count: this.pending.items.length,
        direct_count: this.pending.direct.length,
        trigger:
          item.trigger ?? (attentionHits.length ? 'attention' : 'random'),
      });
      if (this.pending.omittedMessages > before) {
        log('warn', 'trigger.batch_overflow', {
          turn_id: this.pending.turnId,
          count: this.pending.items.length,
          dropped: this.pending.omittedMessages,
          omitted_direct: this.pending.omittedDirect,
        });
      }
      // 升级为direct批次时可能开启新的首次@收集窗口，后续呼唤不能无限延长它。
      // 清掉计时器后按同一绝对截止时间重新计算，而不是重新计时。
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.wakeAttention(attentionHits);
    this.schedule();
  }

  private replyDelay(): number {
    const minimum = this.config.debounceMs,
      maximum = this.config.delayMaxMs ?? minimum;
    return minimum + Math.floor(this.random() * (maximum - minimum + 1));
  }

  private selectRandom(
    messageId: string,
    metadata: Record<string, unknown> = {},
  ): boolean {
    const now = Date.now();
    this.randomAttempts = this.randomAttempts.filter((t) => now - t < 60000);
    if (
      now - this.lastRandomAt < (this.config.randomCooldownMs ?? 60000) ||
      this.randomAttempts.length >= (this.config.randomMaxPerMinute ?? 2)
    ) {
      log('debug', 'trigger.skipped', {
        ...metadata,
        message_id: messageId,
        reason: 'random_rate_limit',
      });
      return false;
    }
    if (this.random() >= (this.config.randomReplyProbability ?? 0)) {
      log('debug', 'trigger.skipped', {
        ...metadata,
        message_id: messageId,
        reason: 'random_not_selected',
      });
      return false;
    }
    this.lastRandomAt = now;
    this.randomAttempts.push(now);
    return true;
  }

  private schedule(): void {
    if (
      this.running ||
      this.admission ||
      this.timer ||
      this.commandBusy ||
      this.stopped ||
      !this.connected
    ) {
      return;
    }
    if (!this.pending && this.hasHostWork()) {
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          void this.run();
        },
        Math.max(0, this.lastTurn + this.config.cooldownMs - Date.now()),
      );
      return;
    }
    if (!this.pending) {
      return;
    }
    const batch = this.pending;
    if (batch.kind === 'random' && !batch.randomSelected) {
      if (
        !this.selectRandom(batch.primary.entry.messageId, {
          turn_id: batch.turnId,
          group_id: this.groupId,
          actor_id: batch.primary.context.actorId,
        })
      ) {
        this.dropPending('random_batch_skipped');
        return;
      }
      batch.randomSelected = true;
      batch.readyAt = batch.openedAt + this.replyDelay();
    }
    const now = Date.now(),
      wait = Math.max(
        0,
        batch.readyAt - now,
        this.lastTurn + this.config.cooldownMs - now,
      );
    log('debug', 'trigger.scheduled', {
      turn_id: batch.turnId,
      group_id: this.groupId,
      actor_id: batch.primary.context.actorId,
      message_id: batch.primary.entry.messageId,
      wait_ms: wait,
      count: batch.items.length,
      direct_count: batch.direct.length,
    });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, wait);
  }

  private async proposeExtended(
    name: string,
    args: unknown,
    definition: ToolDefinition,
    context: TurnContext,
    memory: Memory,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    return proposeExtended(
      {
        api: this.api,
        groupId: this.groupId,
        config: this.config,
        runtime: this.runtime,
        groupFiles: this.groupFiles,
        groupRequests: this.groupRequests,
        customFaces: this.customFaces,
        imageDownloader: this.imageDownloader,
        moderation: () => this.moderation,
        memory: () => this.memory,
        generation: () => this.generation,
        live: () => this.connected && !this.stopped,
        captureSendReceipt: () => this.sender.captureSendReceipt(),
        claimMessageAck: (entry, receipt) =>
          this.sender.claimMessageAck(entry, receipt),
      },
      name,
      args,
      definition,
      context,
      memory,
      signal,
    );
  }

  private async command(text: string, context: TurnContext): Promise<void> {
    if (context.actorId !== this.ownerId) {
      log('warn', 'command.denied', { reason: 'owner_required' });
      return;
    }
    if (this.commandBusy || Date.now() < this.commandCooldown) {
      log('debug', 'command.skipped', { reason: 'busy_or_cooldown' });
      return;
    }
    const started = Date.now();
    const phase = text.startsWith('/confirm') ? 'confirm' : 'reset';
    log('info', 'command.start', { phase });
    this.commandBusy = true;
    this.commandCooldown = Date.now() + 2000;
    let outcome = 'completed';
    try {
      if (text === '/reset') {
        this.interrupt('reset');
        this.memory?.clear();
        this.worldTools = undefined;
        this.worldMessageSequences.clear();
        this.runtime.session.reset('owner_reset');
        (this.model as (Model & { reset?: () => void }) | undefined)?.reset?.();
        await this.sendText('本群对话记忆已清空。', context);
      } else if (/^\/confirm [a-f0-9]{8,64}$/.test(text)) {
        const generation = this.generation;
        const result = await this.moderation.confirm(
          text.split(' ')[1]!,
          context,
        );
        if (generation !== this.generation || !this.connected || this.stopped) {
          return;
        }
        await this.sendText(
          result.status === 'executed'
            ? '已执行确认的管理操作。'
            : result.status === 'ok' && result.submitted === true
              ? '确认的操作请求已正常提交；未单独核验最终效果，不代表调用失败。'
              : '未能确认执行成功：确认码失效、无权操作、目标核验失败或接口异常。若请求已发出，结果可能不确定，请先核实，不要盲目重试。',
          context,
        );
      }
    } catch {
      outcome = 'failed';
      log('warn', 'command.failed', { reason: 'operation_failed' });
    } finally {
      log('info', 'command.end', {
        phase,
        outcome,
        duration_ms: Date.now() - started,
      });
      this.commandBusy = false;
      this.schedule();
    }
  }

  private async sendText(
    text: string,
    context: TurnContext,
    replyTo?: string,
  ): Promise<void> {
    await this.sender.sendPart(
      {
        segments: [{ type: 'text', data: { text } }],
        text,
        ...(replyTo !== undefined ? { replyTo } : {}),
      },
      context,
    );
  }

  private async run(): Promise<void> {
    if (!this.turnScheduler) {
      await this.runAdmitted();
      return;
    }
    if (
      this.admission ||
      this.running ||
      (!this.pending && !this.hasHostWork()) ||
      this.stopped ||
      !this.connected
    ) {
      return;
    }
    const controller = new AbortController(),
      generation = this.generation,
      started = Date.now();
    this.admission = controller;
    let release: (() => void) | undefined;
    const turnId =
      this.pending?.turnId ?? this.hostWakeId ?? `host_${this.groupId}`;
    log('debug', 'trigger.queued', { group_id: this.groupId, turn_id: turnId });
    try {
      release = await this.turnScheduler.acquire(
        this.groupId,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        this.stopped ||
        !this.connected ||
        (!this.pending && !this.hasHostWork())
      ) {
        return;
      }
      // 随机批次等待全局名额期间可能来了首次@。此时不占着名额，
      // 等其剩余收集窗口结束后再排到已在等待的群后面。
      if (
        this.commandBusy ||
        (this.pending && this.pending.readyAt > Date.now())
      ) {
        return;
      }
      log('debug', 'trigger.admitted', {
        group_id: this.groupId,
        turn_id: turnId,
        wait_ms: Date.now() - started,
      });
      await this.runAdmitted();
    } catch {
      if (!controller.signal.aborted && !this.stopped) {
        log('warn', 'trigger.dropped', {
          group_id: this.groupId,
          turn_id: turnId,
          reason: 'admission_failed',
        });
        this.dropPending('admission_failed');
      }
    } finally {
      release?.();
      if (this.admission === controller) {
        this.admission = undefined;
      }
      this.schedule();
    }
  }

  private async runAdmitted(): Promise<void> {
    const batch = this.pending;
    if (!batch && !this.hasHostWork()) {
      return;
    }
    const context = batch?.primary.context;
    await withLogContext(
      {
        turn_id: batch?.turnId ?? this.hostWakeId,
        group_id: this.groupId,
        ...(context
          ? { actor_id: context.actorId, message_id: context.messageId }
          : {}),
      },
      () => this.runTurn(),
    );
  }

  private get pacer(): SideEffectPacer {
    return (this.ownPacer ??= this.runtime.pacer ?? new SideEffectPacer());
  }

  private ownPacer?: SideEffectPacer;
  /** 沙箱代码当前可调用的工具名：模型当前工具集减去控制wake的工具。 */
  hostToolNames(): string[] {
    if (this.stopped) {
      return [];
    }
    return buildToolDefinitions(this.config)
      .map((tool) => tool.function.name)
      .filter((name) => !SANDBOX_EXCLUDED_TOOLS.includes(name));
  }

  /** 工具使用的memory：读取实时的本群world，写入仍进聊天记录库；禁止快照与压缩。 */
  private sessionMemory(): Memory {
    return {
      append: (entry) => this.memory!.append(entry),
      recent: () => this.runtime.world.recentMessages(128),
      find: (messageId) => this.runtime.world.findMessage(messageId),
      context: () => {
        throw new Error('session_snapshot_forbidden');
      },
      compact: async () => {
        throw new Error('session_compaction_forbidden');
      },
      clear: () => {},
      close: () => {},
    };
  }

  private hostMemory(): Memory | undefined {
    return this.memory ? this.sessionMemory() : undefined;
  }

  /**
   * 执行一次沙箱工具调用。策略、身份和群状态在调用时检查，而非创建任务时。
   * 与模型调用共用同一套实现；结果以返回值给出，不抛异常。
   */
  async executeHostTool(
    name: string,
    args: unknown,
    context: TurnContext,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const generation = this.generation;
    const valid = () =>
      !signal.aborted &&
      !this.stopped &&
      this.connected &&
      generation === this.generation;
    if (!valid() || context.groupId !== this.groupId || !this.config.enabled) {
      return { status: 'error', error: 'host_unavailable' };
    }
    if (!this.hostToolNames().includes(name)) {
      return { status: 'error', error: 'tool_disabled' };
    }
    const memory = this.hostMemory();
    if (!memory) {
      return { status: 'error', error: 'host_unavailable' };
    }
    const visual: ChatContentPart[] = [];
    try {
      const kit = this.hostToolkit({
        memory,
        valid,
        onVisualContent: (parts) => visual.push(...parts),
      });
      const moderation = MODERATION_TOOLS.some(
        (tool) => tool.function.name === name,
      );
      const sideEffect =
        name === 'send_message' ||
        name === 'react_message' ||
        moderation ||
        (kit.extendedTools.has(name) && kit.extendedTools.isSideEffect(name));
      if (sideEffect) {
        await this.pacer.take(signal);
      }
      if (!valid()) {
        return { status: 'error', error: 'cancelled' };
      }
      const confirmation = async (
        result: JsonObject,
        cancel: (code: string) => void,
      ): Promise<JsonObject> => {
        const code = String(result.code);
        try {
          const text = confirmationNotice(result, code);
          const entry = await this.sender.sendPart(
            { segments: [{ type: 'text', data: { text } }], text },
            context,
            signal,
          );
          return {
            status: 'confirmation_required',
            notification_message_id: entry.messageId,
          };
        } catch {
          cancel(code);
          return {
            status: 'unknown',
            error: 'confirmation_notification_failed',
            proposal_cancelled: true,
          };
        }
      };
      if (name === 'send_message') {
        let prepared: PreparedMessage;
        try {
          prepared = await kit.groupTools.prepareMessage(args, context);
        } catch {
          return { status: 'error', error: 'invalid_arguments' };
        }
        try {
          const entry = await this.sender.sendPart(prepared, context, signal);
          return {
            status: 'ok',
            effect_confirmed: true,
            message_id: entry.messageId,
            ...(entry.cancelled_after_dispatch
              ? { cancelled_after_dispatch: true }
              : {}),
            ...(entry.local_projection_failed
              ? { local_projection_failed: true }
              : {}),
          };
        } catch (error) {
          return writeFailure(
            error,
            error instanceof DuplicateMessageAckError
              ? 'duplicate_message_ack'
              : 'delivery_unknown',
          );
        }
      }
      if (moderation) {
        const recallId =
          isObject(args) && typeof args.message_id === 'string'
            ? args.message_id
            : undefined;
        const result = await this.moderation.request(
          name,
          args,
          context,
          signal,
          name === 'recall_message' && recallId
            ? memory.find(recallId)?.userId
            : undefined,
        );
        return result.status === 'confirmation_required'
          ? confirmation(result, (code) => this.moderation.cancelPending(code))
          : result;
      }
      if (name === 'react_message') {
        return kit.reactionTools
          ? await kit.reactionTools.react(
              args,
              context,
              kit.reactionTools.createTurn(),
              signal,
            )
          : { status: 'error', error: 'tool_disabled' };
      }
      if (name === 'get_reaction_users') {
        return kit.reactionUsers
          ? await kit.reactionUsers.read(
              args,
              context,
              kit.reactionUsers.createTurn(),
              signal,
            )
          : { status: 'error', error: 'tool_disabled' };
      }
      if (name === 'read_forward') {
        return kit.forwardTools
          ? await kit.forwardTools.read(
              args,
              context,
              kit.forwardTools.createTurn(),
              signal,
            )
          : { status: 'error', error: 'forward_disabled' };
      }
      if (name === 'view_images') {
        if (!kit.imageTools) {
          return { status: 'error', error: 'images_disabled' };
        }
        const viewed = await kit.imageTools.view(
          args,
          context,
          kit.imageState as ReturnType<ImageTools['createTurn']>,
          signal,
        );
        return {
          ...viewed.result,
          images: await imagePixelsOf(viewed.content),
        };
      }
      if (
        WORLD_TOOL_NAMES.includes(name as (typeof WORLD_TOOL_NAMES)[number])
      ) {
        if (!this.runtime.world) {
          return { status: 'error', error: 'tool_disabled' };
        }
        const world = (this.worldTools ??= new WorldTools({
          store: this.runtime.world,
          groupId: this.groupId,
          selfId: context.selfId,
          wake: () => this.worldWake,
          currentBudget: () => this.worldBudget(),
        }));
        return await world.execute(name, args, context, signal);
      }
      if (GROUP_TOOLS.some((tool) => tool.function.name === name)) {
        return await kit.groupTools.execute(name, args, context);
      }
      if (kit.extendedTools.has(name)) {
        const result = await kit.extendedTools.execute(
          name,
          args,
          context,
          signal,
        );
        if (name === 'view_custom_face' && result.status === 'ok') {
          const {
            visual_content_provided: _,
            visual_content_already_provided: __,
            ...rest
          } = result;
          return { ...rest, images: await imagePixelsOf(visual) };
        }
        if (
          result.status === 'confirmation_required' &&
          typeof result.code === 'string'
        ) {
          return confirmation(result, (code) =>
            this.moderation.cancelPending(code),
          );
        }
        return result;
      }
      return { status: 'error', error: 'tool_disabled' };
    } catch {
      return signal.aborted
        ? { status: 'error', error: 'cancelled' }
        : { status: 'error', error: 'tool_failed' };
    }
  }

  /**
   * 绑定到某份工作memory的工具实现，由模型turn和宿主调用方共用；
   * 每轮策略（去重、复核门槛、预算）由调用方负责。
   */
  private hostToolkit(options: TurnToolkitOptions) {
    return createTurnToolkit(
      {
        api: this.api,
        groupId: this.groupId,
        ownerId: this.ownerId,
        config: this.config,
        runtime: this.runtime,
        observations: this.reactionObservations,
        imageDownloader: this.imageDownloader,
        groupFiles: this.groupFiles,
        groupRequests: this.groupRequests,
        customFaces: this.customFaces,
        memory: () => this.memory,
        proposeExtended: (...args) => this.proposeExtended(...args),
        captureSendReceipt: () => this.sender.captureSendReceipt(),
        claimMessageAck: (entry, receipt) =>
          this.sender.claimMessageAck(entry, receipt),
      },
      options,
    );
  }

  private async runTurn(): Promise<void> {
    if (
      this.running ||
      this.commandBusy ||
      (!this.pending && !this.hasHostWork()) ||
      !this.model ||
      !this.connected ||
      this.stopped
    ) {
      return;
    }
    const hostOnly = !this.pending;
    const batch = this.pending ?? {
      turnId: this.hostWakeId,
      kind: 'sandbox_result' as const,
      items: [] as BatchItem[],
      direct: [] as BatchItem[],
      omittedMessages: 0,
      attentionHits: [],
      omittedAttentionHits: 0,
      primary: {
        context: {
          groupId: this.groupId,
          selfId: this.sandboxSelfId!,
          actorId: '',
          messageId: '',
        } as TurnContext,
        entry: undefined,
        trigger: undefined,
      },
      add: () => {},
      addAttention: () => {},
    };
    this.hostWakeId = newTraceId();
    if (this.attention && !hostOnly) {
      for (const item of this.unreadItems()) {
        batch.add(item, 0);
      }
      batch.addAttention(
        this.attention.evaluate(Date.now(), this.unreadItems().length > 0),
      );
    }
    // 唤醒开始前封存本批丢弃的未读条数，随唤醒元数据交给模型。
    const unreadOmitted = this.unreadOmitted;
    for (const item of this.unreadItems()) {
      this.unread.delete(item.sequence);
    }
    this.unreadOmitted = 0;
    this.armAttention();
    this.pending = undefined;
    const trigger = { ...batch.primary, kind: batch.kind };
    this.running = true;
    this.lastTurn = Date.now();
    this.lastSealedSequence = this.arrivalSequence;
    const started = Date.now();
    let outcome = 'tool_budget_exhausted';
    let reason: string | undefined;
    const toolCallsLimit = this.config.maxToolCallsPerWake ?? 96,
      wakeTimeoutMs = this.config.wakeTimeoutMs ?? 240000;
    const stats = newTurnStats();
    log('info', 'turn.start', {
      trigger: trigger.trigger ?? batch.kind,
      count: batch.items.length,
      direct_count: batch.direct.length,
      dropped: batch.omittedMessages,
    });
    const controller = new AbortController();
    this.active = controller;
    this.activeCancelReason = undefined;
    const generation = this.generation;
    let attentionTransaction: AttentionTransaction | undefined;
    const attentionRejections: string[] = [];
    const lifetime = setTimeout(() => {
      if (!controller.signal.aborted) {
        this.activeCancelReason = 'turn_timeout';
        controller.abort('turn_timeout');
      }
    }, wakeTimeoutMs);
    const cancellationReason = () =>
      this.activeCancelReason ??
      (controller.signal.aborted ? 'cancelled' : 'generation_changed');
    const session = this.runtime.session;
    let sessionStarted = false,
      assistantSeq: number | undefined,
      recoveredResponseState = false;
    let sessionScope: ModelSessionScope | undefined;
    let finished = false;
    const wake: WakeFlags = {
      lastSendAt: 0,
      sending: false,
      managementNeedsReview: false,
      customFaceNeedsReview: false,
    };
    const valid = () =>
      !controller.signal.aborted &&
      !this.stopped &&
      this.connected &&
      generation === this.generation;
    try {
      attentionTransaction = this.attention?.begin(
        Date.now(),
        trigger.context.selfId,
      );
      // 工具查询实时的本群world；批次在任何await之前封存，新到达的消息只进入下一批唤醒。
      const sentEntries = new Map<string, TimelineEntry>();
      const workingMemory = withSentEntries(this.sessionMemory(), sentEntries);
      const moderationPolicy = this.config.tools.moderation;
      const observations = this.reactionObservations;
      const lookupReaction = (messageId: string) =>
        observations?.get(messageId);
      const pendingCustomFaceImages: ChatContentPart[] = [];
      this.groupFiles.resetWake();
      this.groupRequests.resetWake();
      const {
        groupTools,
        imageTools,
        imageState,
        forwardTools,
        reactionTools,
        reactionUsers,
        extendedTools,
      } = this.hostToolkit({
        memory: workingMemory,
        valid,
        onVisualContent: (parts) => pendingCustomFaceImages.push(...parts),
        onSent: (entry) =>
          sentEntries.set(entry.messageId, structuredClone(entry)),
      });
      if (!valid()) {
        return;
      }
      const wakeBudget = () => ({
        max_tool_calls: toolCallsLimit,
        used_tool_calls: stats.toolCalls,
        remaining_tool_calls: toolCallsLimit - stats.toolCalls,
        remaining_ms: Math.max(0, wakeTimeoutMs - (Date.now() - started)),
      });
      const tools = buildToolDefinitions(this.config);
      const system = buildSystemPrompt(
        { ...this.config, groupId: this.groupId },
        tools,
      );
      // 发给模型的形态；校验、确认与沙箱仍使用完整定义tools。
      const presented = presentTools(tools, toolSchemaMode(this.config));
      // 唤醒原因：关注唤醒附本次命中的计划（批次最多64条，purpose不超过160字）。
      const wakeTrigger: JsonObject = {
        type: batch.kind,
        ...(batch.attentionHits.length
          ? { plan_hits: structuredClone(batch.attentionHits) as JsonObject[] }
          : {}),
        ...(batch.omittedAttentionHits
          ? { omitted_plan_hits: batch.omittedAttentionHits }
          : {}),
        ...(unreadOmitted ? { unread_omitted: unreadOmitted } : {}),
      };
      this.worldWake = {
        wakeId: batch.turnId,
        startedAt: started / 1000,
        trigger: { type: batch.kind },
      };
      this.worldBudget = wakeBudget;
      this.worldTools ??= new WorldTools({
        store: this.runtime.world,
        groupId: this.groupId,
        selfId: trigger.context.selfId,
        wake: () => this.worldWake,
        currentBudget: () => this.worldBudget(),
      });
      session.beginWake(system, presented, {
        wake_id: batch.turnId,
        group_id: this.groupId,
        trigger: wakeTrigger,
        wake_budget: wakeBudget(),
      });
      sessionStarted = true;
      sessionScope = session.state();
      session.projectExternalEvents(trigger.context.selfId);
      if (this.runtime.sandboxSummary) {
        const summary = this.runtime.sandboxSummary(
          trigger.context.selfId,
          this.groupId,
        );
        if (Array.isArray(summary.jobs) && summary.jobs.length) {
          session.appendInput(
            JSON.stringify({
              host_event: { type: 'javascript_job_summary', ...summary },
            }),
          );
        }
      }
      const management = new WakeManagement(
        new Set(
          buildModerationTools(moderationPolicy).map(
            (tool) => tool.function.name,
          ),
        ),
        {
          pacer: this.pacer,
          moderation: () => this.moderation,
          sender: this.sender,
          memory: workingMemory,
          stats,
          wake,
          valid,
          onNotified: (entry) =>
            sentEntries.set(entry.messageId, structuredClone(entry)),
        },
      );
      const sending = new WakeSend({
        pacer: this.pacer,
        sender: this.sender,
        stats,
        wake,
        valid,
        onSent: (entry) =>
          sentEntries.set(entry.messageId, structuredClone(entry)),
      });
      const extended = new WakeExtended({
        config: this.config,
        tools: extendedTools,
        definitions: tools,
        pacer: this.pacer,
        moderation: () => this.moderation,
        sender: this.sender,
        pendingImages: pendingCustomFaceImages,
        stats,
        wake,
        valid,
        onNotified: (entry) =>
          sentEntries.set(entry.messageId, structuredClone(entry)),
      });
      const appendToolResult = (
        call: { id: string; function?: { name: string } },
        result: JsonObject,
      ) => {
        const readTime = [
          'get_group_members',
          'get_member_info',
          'read_message',
          'read_forward',
          'get_reaction_users',
          'view_images',
          'list_custom_faces',
          'view_custom_face',
        ].includes(call.function?.name ?? '')
          ? Date.now() / 1000
          : undefined;
        const boundedResult = {
          ...result,
          ...(readTime === undefined
            ? {}
            : {
                queried_at: readTime,
                current_time: {
                  unix_seconds: readTime,
                  utc: new Date(readTime * 1000).toISOString(),
                },
              }),
          wake_budget: wakeBudget(),
        };
        session.finishTool(call.id, boundedResult, assistantSeq);
      };
      const forwardState = forwardTools?.createTurn();
      const reactionState = reactionTools?.createTurn();
      const reactionUserState = reactionUsers?.createTurn();
      for (let round = 0; valid(); round++) {
        if (stats.toolCalls >= toolCallsLimit) {
          outcome = 'tool_budget_exhausted';
          break;
        }
        stats.modelRounds++;
        const requestMessages = session.messages();
        let response: Awaited<ReturnType<Model['complete']>>;
        try {
          response = await withLogContext(
            { round: round + 1, phase: 'conversation' },
            () =>
              this.model!.complete(
                requestMessages,
                presented,
                controller.signal,
              ),
          );
        } catch (error) {
          if (
            error instanceof ResponseStateExpiredError &&
            !recoveredResponseState &&
            valid()
          ) {
            recoveredResponseState = true;
            session.reset('response_state_expired');
            if (this.model instanceof ResponsesModel) {
              this.model.reset();
            }
            session.beginWake(system, presented, {
              wake_id: batch.turnId,
              group_id: this.groupId,
              trigger: { type: batch.kind },
              wake_budget: wakeBudget(),
              recovery: {
                read_tools_again: true,
                earlier_actions_may_have_completed: stats.toolCalls > 0,
              },
            });
            sessionScope = session.state();
            assistantSeq = undefined;
            continue;
          }
          throw error;
        }
        if (!valid()) {
          break;
        }
        const checkpoint = session.appendAssistant(
          response,
          this.runtime.modelRequestId?.(),
        );
        assistantSeq = checkpoint.assistantSeq;
        if (this.model instanceof ResponsesModel) {
          session.setTransportCheckpoint(
            this.model.getContinuationCheckpoint(),
          );
        }
        if (!valid()) {
          break;
        }
        if (!response.tool_calls.length) {
          outcome = 'prose_suppressed';
          break;
        } // 模型的普通文本输出有意不转发到群里。
        const finishIndex = response.tool_calls.findIndex((call) => {
          if (call.function.name !== 'finish') {
            return false;
          }
          try {
            const args: unknown = JSON.parse(call.function.arguments);
            return isObject(args) && keys(args, []);
          } catch {
            return false;
          }
        });
        const activeCalls =
          finishIndex < 0
            ? response.tool_calls
            : response.tool_calls.slice(0, finishIndex + 1);
        const viewingImages = activeCalls.some(
          (call) =>
            call.function.name === 'view_images' ||
            call.function.name === 'view_custom_face',
        );
        const readingForward = activeCalls.some(
          (call) => call.function.name === 'read_forward',
        );
        const transcribingVoice = activeCalls.some(
          (call) => call.function.name === 'transcribe_voice',
        );
        const imageContent: ChatContentPart[] = [];
        let terminal = false;
        wake.managementNeedsReview = false;
        wake.customFaceNeedsReview = false;
        for (const call of response.tool_calls) {
          if (!valid()) {
            break;
          }
          if (stats.toolCalls >= toolCallsLimit) {
            if (!terminal) {
              outcome = 'tool_budget_exhausted';
            }
            break;
          }
          stats.toolCalls++;
          const toolStarted = Date.now();
          const toolName = tools.some(
            (tool) => tool.function.name === call.function.name,
          )
            ? call.function.name
            : 'invalid';
          if (!session.startTool(call.id, assistantSeq)) {
            throw new Error('tool_checkpoint_refused');
          }
          log('info', 'tool.start', { tool: toolName, round: round + 1 });
          const traceResult = (result: JsonObject) =>
            logToolResult(toolName, result, toolStarted, round + 1);
          let result: JsonObject = {
            status: 'error',
            error: 'invalid_arguments',
          };
          let args: unknown;
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = undefined;
          }
          if (terminal) {
            const done = { status: 'error', error: 'turn_finished' };
            traceResult(done);
            appendToolResult(call, done);
            continue;
          }
          const definition = tools.find(
            (tool) => tool.function.name === call.function.name,
          );
          const wrapper =
            isObject(args) && Object.keys(args).length === 1
              ? ['params', '_'].find((key) => Object.hasOwn(args, key))
              : undefined;
          // 声明写成 function x(_: {...})，模型偶尔把参数包进 params 或 _；不代为解包，只提示改法。
          if (
            definition &&
            wrapper &&
            !Object.hasOwn(
              definition.function.parameters.properties ?? {},
              wrapper,
            )
          ) {
            const wrapped = {
              status: 'error',
              error: 'invalid_arguments',
              reason_code: 'wrapped_arguments',
              hint: `arguments 应直接是参数对象，去掉外层的 ${wrapper}`,
            };
            traceResult(wrapped);
            appendToolResult(call, wrapped);
            continue;
          }
          if (
            TOOL_NAMES.includes(
              call.function.name as (typeof TOOL_NAMES)[number],
            ) &&
            !tools.some((tool) => tool.function.name === call.function.name)
          ) {
            const denied = { status: 'error', error: 'tool_disabled' };
            traceResult(denied);
            appendToolResult(call, denied);
            continue;
          }
          if (
            call.function.name === 'finish' &&
            isObject(args) &&
            keys(args, []) &&
            !viewingImages &&
            !readingForward &&
            !transcribingVoice &&
            !wake.customFaceNeedsReview
          ) {
            outcome = stats.sentMessages ? 'replied' : 'silent';
            finished = true;
            terminal = true;
            traceResult({ status: 'ok' });
            appendToolResult(call, { status: 'ok' });
            break;
          }
          if (
            wake.managementNeedsReview &&
            (call.function.name === 'send_message' ||
              extendedTools.isSideEffect(call.function.name) ||
              (wake.customFaceNeedsReview && call.function.name === 'finish'))
          ) {
            const blocked = {
              status: 'error',
              error: 'management_result_review_required',
              reason_code: 'management_result_review_required',
            };
            traceResult(blocked);
            appendToolResult(call, blocked);
            continue;
          }
          if (
            (viewingImages || readingForward || transcribingVoice) &&
            (extendedTools.isSideEffect(call.function.name) ||
              [
                'send_message',
                'finish',
                'manage_attention',
                'react_message',
                ...MODERATION_TOOLS.map((tool) => tool.function.name),
              ].includes(call.function.name))
          ) {
            const reason = viewingImages
              ? 'image_first'
              : readingForward
                ? 'forward_first'
                : 'transcription_first';
            traceResult({ status: 'error', error: reason });
            appendToolResult(call, {
              status: 'error',
              reason_code: reason,
              error: viewingImages
                ? '先接收本轮图片内容，再在下一轮决定回复或操作。'
                : readingForward
                  ? '先接收本轮转发读取结果，再在下一轮决定回复或操作。'
                  : reason,
            });
            continue;
          }
          if (
            EXTENDED_TOOL_NAMES.includes(
              call.function.name as (typeof EXTENDED_TOOL_NAMES)[number],
            )
          ) {
            const handled = await extended.execute(
              call,
              args,
              trigger.context,
              controller.signal,
              imageContent,
            );
            if (!handled) {
              return;
            }
            result = handled;
            traceResult(result);
            appendToolResult(call, result);
            if (!valid()) {
              return;
            }
            continue;
          }
          if (
            WORLD_TOOL_NAMES.includes(
              call.function.name as (typeof WORLD_TOOL_NAMES)[number],
            )
          ) {
            result = await this.worldTools!.execute(
              call.function.name,
              args,
              trigger.context,
              controller.signal,
            );
            if (
              call.function.name === 'ack_events' &&
              result.status === 'ok' &&
              typeof result.observed_through === 'number'
            ) {
              this.acknowledgeObserved(result.observed_through);
            }
            traceResult(result);
            appendToolResult(call, result);
            continue;
          }
          if (call.function.name === 'get_reaction_users') {
            result =
              reactionUsers && reactionUserState
                ? await reactionUsers.read(
                    args,
                    trigger.context,
                    reactionUserState,
                    controller.signal,
                  )
                : { status: 'error', error: 'tool_disabled' };
            if (!valid()) {
              return;
            }
            traceResult(result);
            appendToolResult(call, result);
            continue;
          }
          if (call.function.name === 'react_message') {
            if (reactionTools && reactionState) {
              await this.pacer.take(controller.signal);
              if (!valid()) {
                return;
              }
            }
            result =
              reactionTools && reactionState
                ? await reactionTools.react(
                    args,
                    trigger.context,
                    reactionState,
                    controller.signal,
                  )
                : { status: 'error', error: 'tool_disabled' };
            if (!result.duplicate) {
              if (
                reactionUsers &&
                reactionUserState &&
                typeof result.message_id === 'string' &&
                typeof result.emoji_id === 'string'
              ) {
                reactionUsers.invalidate(
                  reactionUserState,
                  result.message_id,
                  result.emoji_id,
                );
              }
              countReaction(stats, result);
            }
            traceResult(result);
            appendToolResult(call, result);
            if (!valid()) {
              return;
            }
            continue;
          }
          if (call.function.name === 'manage_attention') {
            result =
              this.attention && attentionTransaction
                ? this.attention.stage(attentionTransaction, args, Date.now())
                : { status: 'error', error: 'tool_disabled' };
            if (result.status === 'error' && attentionRejections.length < 32) {
              attentionRejections.push(
                typeof result.error === 'string'
                  ? result.error
                  : 'invalid_arguments',
              );
            }
            traceResult(result);
            appendToolResult(call, result);
            continue;
          }
          if (call.function.name === 'read_forward') {
            result =
              forwardTools && forwardState && this.config.forward.enabled
                ? await withLogContext({ round: round + 1 }, () =>
                    forwardTools!.read(
                      args,
                      trigger.context,
                      forwardState,
                      controller.signal,
                    ),
                  )
                : { status: 'error', error: 'forward_disabled' };
            if (!valid()) {
              return;
            }
            traceResult(result);
            appendToolResult(call, result);
            continue;
          }
          if (call.function.name === 'view_images') {
            if (!imageTools || !imageState || !this.config.images.enabled) {
              result = { status: 'error', error: 'images_disabled' };
            } else {
              const viewed = await imageTools.view(
                args,
                trigger.context,
                imageState,
                controller.signal,
              );
              if (!valid()) {
                return;
              }
              result = viewed.result;
              imageContent.push(...viewed.content);
            }
            traceResult(result);
            appendToolResult(call, result);
            continue;
          }
          if (call.function.name === 'send_message') {
            let prepared: PreparedMessage;
            try {
              prepared = await groupTools.prepareMessage(args, trigger.context);
            } catch {
              traceResult({ status: 'error', error: 'invalid_arguments' });
              appendToolResult(call, {
                status: 'error',
                error: 'invalid_arguments',
              });
              continue;
            }
            if (!valid()) {
              return;
            }
            const sent = await sending.send(
              prepared,
              trigger.context,
              controller.signal,
            );
            if (!sent) {
              return;
            }
            result = sent;
            traceResult(result);
            appendToolResult(call, result);
            if (!valid()) {
              return;
            }
            continue;
          } else if (
            GROUP_TOOLS.some((t) => t.function.name === call.function.name) &&
            groupTools
          ) {
            result = await groupTools.execute(
              call.function.name,
              args,
              trigger.context,
            );
            if (
              call.function.name === 'read_message' &&
              observations &&
              result.status === 'ok' &&
              isObject(result.message) &&
              typeof result.message.messageId === 'string'
            ) {
              await observations.refresh(
                workingMemory,
                [result.message.messageId],
                controller.signal,
                true,
              );
              if (!valid()) {
                return;
              }
              result = annotateReactionReadResult(result, lookupReaction);
            }
          } else if (
            MODERATION_TOOLS.some((t) => t.function.name === call.function.name)
          ) {
            const managed = await management.execute(
              call,
              args,
              trigger.context,
              controller.signal,
            );
            if (!managed) {
              return;
            }
            result = managed;
          }
          traceResult(result);
          appendToolResult(call, result);
        }
        if (terminal) {
          return;
        }
        // Chat Completions要求所有工具结果都出现在下一条user图片消息之前。
        // 这些图片字节只存在于本轮，绝不追加到共享memory。
        if (imageContent.length && valid()) {
          session.appendInput([
            {
              type: 'text',
              text: VIEWED_IMAGES_NOTICE,
            },
            ...imageContent,
          ]);
        }
      }
    } catch (error) {
      if (sessionStarted) {
        try {
          session.skipPending(
            !valid()
              ? cancellationReason()
              : error instanceof ModelError
                ? error.code
                : 'operation_failed',
            sessionScope,
          );
        } catch {
          log('error', 'session.checkpoint_failed', {
            reason: 'operation_failed',
          });
        }
      }
      if (
        error instanceof ResponseStateExpiredError &&
        sessionScope &&
        session.state().sessionId === sessionScope.sessionId &&
        session.state().wakeId === sessionScope.wakeId
      ) {
        session.reset('response_state_expired');
        sessionStarted = false;
      }
      outcome = wake.sending
        ? 'delivery_unknown'
        : error instanceof ModelError
          ? 'model_failed'
          : 'failed';
      reason =
        error instanceof ModelError || error instanceof OneBotError
          ? error.code
          : 'operation_failed';
    } finally {
      clearTimeout(lifetime);
      const normalFinish = valid() && finished;
      if (outcome === 'silent') {
        outcome = silentOutcome(stats);
      }
      if (!valid() && outcome !== 'delivery_unknown') {
        outcome = cancelledOutcome(stats);
        reason = cancellationReason();
      }
      if (sessionStarted) {
        try {
          if (!valid()) {
            session.skipPending(cancellationReason(), sessionScope);
          }
          session.finishWake(
            outcome,
            {
              reason_code:
                reason ??
                (['tool_budget_exhausted', 'prose_suppressed'].includes(outcome)
                  ? outcome
                  : undefined),
              duration_ms: Math.max(0, Date.now() - started),
              tool_calls_limit: toolCallsLimit,
              wake_timeout_ms: wakeTimeoutMs,
              ...turnStatsFields(stats),
            },
            sessionScope,
          );
        } catch {
          outcome = 'failed';
          reason = 'session_checkpoint_failed';
          log('error', 'session.checkpoint_failed', { reason });
        }
      }
      log(
        stats.reactionUnknown ||
          stats.reactionFailures ||
          [
            'failed',
            'model_failed',
            'delivery_unknown',
            'tool_budget_exhausted',
          ].includes(outcome)
          ? 'warn'
          : 'info',
        'turn.end',
        {
          outcome,
          reason,
          tool_calls_limit: toolCallsLimit,
          ...turnStatsFields(stats),
          duration_ms: Date.now() - started,
        },
      );
      try {
        if (this.attention && attentionTransaction && normalFinish) {
          const committed = this.attention.commit(
            attentionTransaction,
            Date.now(),
            this.arrivalSequence,
          );
          if (committed.status === 'error') {
            log('warn', 'attention.commit_failed', { reason: 'commit_failed' });
          }
          if (
            attentionRejections.length ||
            (Array.isArray(committed.applied) && committed.applied.length) ||
            (Array.isArray(committed.skipped) && committed.skipped.length)
          ) {
            log('info', 'attention.commit', {
              count: Array.isArray(committed.applied)
                ? committed.applied.length
                : 0,
              dropped: Array.isArray(committed.skipped)
                ? committed.skipped.length
                : 0,
            });
          }
        }
      } catch {
        log('warn', 'attention.commit_failed', { reason: 'operation_failed' });
      }
      this.armAttention();
      this.active = undefined;
      this.running = false;
      this.schedule();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.interrupt('shutdown');
    // 等进行中的异步工作感知到取消后再关闭数据库。
    while (
      this.running ||
      this.admission ||
      this.commandBusy ||
      this.reads > 0
    ) {
      await delay(20);
    }
    this.memory?.close();
    this.runtime.session.close();
    this.runtime.world.close();
    if (this.ownsCustomFaces) {
      this.customFaces?.coordinator.close();
      this.customFaces?.store.close();
    }
  }
}

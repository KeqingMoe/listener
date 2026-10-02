import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadAppConfig } from '../config/loader.ts';
import { ConfigError } from '../config/errors.ts';
import { assertStoragePaths } from '../config/storage-paths.ts';
import { toListenerConfig } from '../config/runtime.ts';
import { OneBotClient } from '../onebot/client.ts';
import { id } from '../onebot/identity.ts';
import { Listener } from '../agent/listener.ts';
import { OpenAIModel } from '../model/chat.ts';
import { SQLiteMemory } from '../agent/memory.ts';
import { WorldEventStore } from '../world/events.ts';
import { ResponsesModel } from '../model/responses.ts';
import type {
  ModelRequestRecord,
  ModelRequestStart,
} from '../observability/model-usage.ts';
import { ModelSession } from '../agent/session/store.ts';
import { GroupRouter } from './group-router.ts';
import { GroupRegistry } from '../config/group-registry.ts';
import { TurnScheduler } from '../agent/scheduler.ts';
import {
  configureLogging,
  getLogContext,
  log,
  observeLogs,
} from '../observability/logger.ts';
import { RuntimeEventStore } from '../observability/runtime-events.ts';
import { TelemetryStore } from '../observability/telemetry.ts';
import { ToolObservationStore } from '../observability/tool-call-observations.ts';
import { FACE_CATALOG, EXAMPLE_FACE_CATALOG } from '../onebot/catalog/faces.ts';
import { getReactionCatalog } from '../onebot/catalog/reactions.ts';
import { CustomFaceStore } from '../tools/custom-faces/store.ts';
import { CustomFaceCoordinator } from '../tools/custom-faces/coordinator.ts';
import { SharedCustomFaceStaging } from '../tools/custom-faces/staging.ts';
import { ReminderStore } from '../reminders/store.ts';
import { ReminderScheduler } from '../reminders/scheduler.ts';
import { SandboxService } from '../sandbox/service.ts';
import { SandboxJobStore } from '../sandbox/store.ts';
import { WebTools } from '../tools/web/tools.ts';
import { ArtifactStore } from '../artifacts/store.ts';
import { createSearchBackend } from '../tools/web/search.ts';

let logger: ReturnType<typeof configureLogging> | undefined;
let telemetry: TelemetryStore | undefined;
let toolObservations: ToolObservationStore | undefined;
let runtimeEvents: RuntimeEventStore | undefined,
  stopObserving: (() => void) | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let registry: GroupRegistry | undefined;
let customFaceStore: CustomFaceStore | undefined;
let customFaceCoordinator: CustomFaceCoordinator | undefined;
let reminderStore: ReminderStore | undefined;
let reminderScheduler: ReminderScheduler | undefined;
let sandboxStore: SandboxJobStore | undefined;
let artifactStore: ArtifactStore | undefined;
let sandboxService: SandboxService | undefined;

async function main(): Promise<void> {
  const app = loadAppConfig();
  const { onebot: config, runtime } = app;
  const secrets = [
    config.token,
    ...[...app.models.values()].map((model) => model.apiKey),
  ];
  logger = configureLogging(app.logging, secrets);
  log('info', 'app.start', {
    count: app.configuredGroupIds.filter(
      (groupId) => app.resolveGroup(groupId).enabled,
    ).length,
  });
  log(
    FACE_CATALOG === EXAMPLE_FACE_CATALOG ? 'warn' : 'info',
    'app.faces_ready',
    {
      count: FACE_CATALOG.length,
      reason:
        FACE_CATALOG === EXAMPLE_FACE_CATALOG
          ? 'example_catalog'
          : 'local_catalog',
    },
  );
  const client = new OneBotClient(config);
  const scheduler = new TurnScheduler(runtime.maxConcurrentTurns);
  process.umask(0o077);
  mkdirSync(dirname(app.storage.telemetryPath), {
    recursive: true,
    mode: 0o700,
  });
  telemetry = new TelemetryStore(app.storage.telemetryPath, {
    secrets,
  });
  try {
    runtimeEvents = new RuntimeEventStore(app.storage.telemetryPath);
    stopObserving = observeLogs((record) => runtimeEvents?.record(record));
  } catch {
    log('warn', 'app.diagnostics_unavailable', { reason: 'storage_failed' });
  }
  const declared = app.configuredGroupIds.map((groupId) =>
    app.resolveGroup(groupId),
  );
  const enabledGroups = new Map(
    declared.map((group) => [group.groupId, group.enabled]),
  );
  registry = new GroupRegistry(app, () =>
    log('warn', 'app.registry_failed', { reason: 'storage_failed' }),
  );
  mkdirSync(app.storage.directory, { recursive: true, mode: 0o700 });
  reminderStore = new ReminderStore({
    path: resolve(app.storage.directory, 'reminders.sqlite'),
  });
  sandboxStore = new SandboxJobStore({
    path: resolve(app.storage.directory, 'sandbox.sqlite'),
  });
  try {
    let observationWarningEmitted = false;
    toolObservations = new ToolObservationStore(app.storage.telemetryPath, {
      onError: () => {
        // Do not send this through the logger's observer back into the same failing SQLite DB.
        if (!observationWarningEmitted) {
          observationWarningEmitted = true;
          console.warn(
            'tool observation storage unavailable; counts may be incomplete',
          );
        }
      },
    });
  } catch {
    log('warn', 'app.tool_observations_unavailable', {
      reason: 'storage_failed',
    });
  }
  sandboxService = new SandboxService({
    store: sandboxStore,
    observer: toolObservations,
  });
  artifactStore = new ArtifactStore({
    path: resolve(app.storage.directory, 'artifacts.sqlite'),
    directory: app.storage.artifactDirectory,
    providerDirectory: app.storage.napcatArtifactDirectory,
  });
  const artifactSweep = setInterval(
    () => {
      void artifactStore
        ?.sweep()
        .catch(() =>
          log('warn', 'app.artifact_sweep_failed', { reason: 'sweep_failed' }),
        );
    },
    10 * 60 * 1000,
  );
  artifactSweep.unref();
  const webTools = new WebTools({
    ...(app.web.search ? { search: createSearchBackend(app.web.search) } : {}),
  });
  customFaceStore = new CustomFaceStore({
    path: resolve(app.storage.directory, 'custom-faces.sqlite'),
  });
  customFaceCoordinator = new CustomFaceCoordinator({
    path: resolve(app.storage.directory, 'custom-face-operations.sqlite'),
  });
  const customFaces = {
    store: customFaceStore,
    coordinator: customFaceCoordinator,
    staging: new SharedCustomFaceStaging({
      directory: app.storage.customFaceDirectory,
      providerDirectory: app.storage.napcatCustomFaceDirectory,
    }),
  };
  const router: GroupRouter = new GroupRouter({
    enabled: (groupId) => enabledGroups.get(groupId) ?? app.defaultsEnabled,
    listGroups: () => client.call('get_group_list', { no_cache: true }),
    membershipChanged: (groupIds) => {
      registry!.update(groupIds);
    },
    onError: (reason) => log('warn', 'app.group_discovery_failed', { reason }),
    create: async (groupId) => {
      const policy = app.resolveGroup(groupId);
      if (!policy.enabled) {
        throw new Error('Group disabled');
      }
      assertStoragePaths(
        app.storage,
        router.groupIds.map((value) => app.resolveGroup(value)),
      );
      const group = toListenerConfig(app, policy);
      const modelConfig = app.models.get(policy.model)!;
      let lastRequestId: string | undefined;
      let memory: SQLiteMemory | undefined,
        world: WorldEventStore | undefined,
        session: ModelSession | undefined;
      const contexts = new Map<
        string,
        {
          groupId: string;
          modelName: string;
          turnId?: string;
          phase?: string;
          wakeId?: string;
        }
      >();
      const context = () => {
        const trace = getLogContext();
        return {
          groupId,
          modelName: policy.model,
          ...(typeof trace.turn_id === 'string'
            ? { turnId: trace.turn_id }
            : {}),
          ...(typeof trace.phase === 'string' ? { phase: trace.phase } : {}),
          ...(session?.state().wakeId
            ? { wakeId: session.state().wakeId! }
            : {}),
        };
      };
      const scoped = {
        baseUrl: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        timeoutMs: modelConfig.timeoutMs,
        maxTokens: modelConfig.maxTokens,
        ...(modelConfig.opencodeHeaders
          ? {
              requestHeaders: () => {
                if (!session) {
                  throw new Error('Model session is not initialized');
                }
                return { 'x-opencode-session': session.state().sessionId };
              },
            }
          : {}),
        onRequestStart: (record: ModelRequestStart) => {
          const scope = context();
          contexts.set(record.requestId, scope);
          lastRequestId = record.requestId;
          try {
            telemetry?.beginRequest({ ...record, ...scope });
          } catch {
            log('warn', 'model.telemetry_failed', { reason: 'storage_failed' });
          }
        },
        onRequest: (record: ModelRequestRecord) => {
          lastRequestId = record.requestId;
          const scope = contexts.get(record.requestId) ?? context();
          contexts.delete(record.requestId);
          try {
            telemetry?.record({ ...record, ...scope });
          } catch {
            log('warn', 'model.telemetry_failed', { reason: 'storage_failed' });
          }
        },
      };
      const transport = modelConfig.transport;
      const model =
        transport === 'chat'
          ? new OpenAIModel(scoped)
          : new ResponsesModel({
              ...scoped,
              sessionId: `group:${groupId}`,
              ...(typeof transport === 'object'
                ? { incremental: transport.incremental }
                : {}),
            });
      try {
        mkdirSync(dirname(policy.storage.databasePath), {
          recursive: true,
          mode: 0o700,
        });
        memory = new SQLiteMemory({
          path: policy.storage.databasePath,
          // 仅作为缓存构造参数的上限；生产环境的ModelSession不会按此预算做摘要。
          maxContextChars: 24000,
          retentionDays: policy.history.retentionDays,
          groupId,
        });
        world = new WorldEventStore({
          path: `${policy.storage.databasePath}.events.sqlite`,
          groupId,
          retentionDays: policy.history.retentionDays,
        });
        session = new ModelSession({
          path: `${policy.storage.databasePath}.session.sqlite`,
          groupId,
          model: policy.model,
          maxTranscriptBytes: policy.session.maxTranscriptBytes,
        });
        if (model instanceof ResponsesModel) {
          const checkpoint = session.getTransportCheckpoint();
          if (checkpoint) {
            try {
              model.restoreContinuationCheckpoint(checkpoint);
            } catch {
              session.reset('invalid_transport_checkpoint');
            }
          }
        }
        for (const entry of memory.recent()) {
          world.appendMessage(entry, {
            source: 'migration',
            observedAt: entry.time,
          });
        }
        chmodSync(policy.storage.databasePath, 0o600);
        const listener = new Listener(
          client,
          model,
          memory,
          group,
          Math.random,
          undefined,
          scheduler,
          {
            world,
            session,
            modelRequestId: () => lastRequestId,
            customFaces,
            reminders: reminderStore,
            web: webTools,
            artifacts: artifactStore,
            sandbox: sandboxService,
            sandboxSummary: (self, group) => {
              const jobs = sandboxService?.summary(self, group) ?? [];
              return jobs.length
                ? {
                    jobs: jobs.map((j) => ({
                      job_id: j.jobId,
                      status: j.status,
                      description: j.description,
                    })),
                  }
                : {};
            },
          },
        );
        if (group.observeReactions) {
          log('info', 'app.reactions_ready', {
            count: getReactionCatalog().length,
          });
        }
        log('info', 'app.group_ready', { group_id: groupId });
        return listener;
      } catch (error) {
        for (const resource of [memory, world, session]) {
          try {
            resource?.close();
          } catch {
            log('warn', 'app.group_cleanup_failed', { reason: 'close_failed' });
          }
        }
        log('error', 'app.group_init_failed', {
          group_id: groupId,
          reason: 'group_initialization_failed',
        });
        throw error;
      }
    },
  });
  sandboxService.setToolBridge({
    names: (scope) => router.hostToolNames(scope.selfId, scope.groupId),
    call: (scope, name, args, signal) =>
      router.executeHostTool(
        {
          groupId: scope.groupId,
          selfId: scope.selfId,
          actorId: scope.actorId,
          messageId: scope.messageId,
        },
        name,
        args,
        signal,
      ),
  });
  let sandboxFlush: Promise<void> | undefined;
  const flushSandbox = (): Promise<void> => {
    if (sandboxFlush) {
      return sandboxFlush;
    }
    sandboxFlush = (async () => {
      const account = router.reminderAccount;
      if (!account) {
        return;
      }
      let cursor = 0;
      for (;;) {
        const page = sandboxService!.pendingResults(account, 100, cursor);
        for (const job of page.jobs) {
          try {
            await router.dispatchSandboxResult({
              ...job,
              jobId: job.jobId,
              selfId: job.selfId,
              groupId: job.groupId,
            });
            sandboxService!.ackResult(account, job.groupId, job.jobId);
          } catch {
            /* 暂不可用的群不ack，结果保留待下次投递。 */
          }
        }
        if (page.nextCursor === null) {
          break;
        }
        cursor = page.nextCursor;
      }
    })()
      .catch(() => {})
      .finally(() => {
        sandboxFlush = undefined;
      });
    return sandboxFlush;
  };
  const unsubscribeSandbox = sandboxService.subscribe(() => {
    void flushSandbox();
  });
  const sandboxPulse = setInterval(() => {
    void flushSandbox();
  }, 15000);
  sandboxPulse.unref();
  reminderScheduler = new ReminderScheduler({
    store: reminderStore,
    currentAccount: () => router.reminderAccount,
    eligible: (groupId) => {
      const group = app.resolveGroup(groupId);
      return group.enabled && group.tools.create_reminder.mode === 'direct';
    },
    dispatch: (reminder, claim) => router.dispatchReminder(reminder, claim),
  });
  reminderScheduler.start();
  let selfId: string | undefined,
    stopping = false;
  const pulse = () =>
    log('debug', 'app.heartbeat', {
      status: selfId ? 'connected' : 'disconnected',
    });
  pulse();
  heartbeat = setInterval(pulse, 15000);
  heartbeat.unref();
  client.on('ready', (data: unknown) => {
    selfId =
      data && typeof data === 'object' && 'user_id' in data
        ? id(data.user_id)
        : undefined;
    if (!selfId) {
      router.setConnected(false);
      log('warn', 'onebot.identity_failed');
      return;
    }
    const identity = selfId;
    void router
      .connect(identity)
      .then(() => {
        if (selfId === identity && !stopping) {
          void flushSandbox();
          log('info', 'onebot.ready', { count: router.size });
        }
      })
      .catch(() =>
        log('warn', 'app.group_discovery_failed', {
          reason: 'group_initialization_failed',
        }),
      );
  });
  client.on('disconnected', () => {
    selfId = undefined;
    router.setConnected(false);
    if (!stopping) {
      log('warn', 'onebot.disconnected');
    }
  });
  const receive = (event: unknown) => {
    if (!selfId || stopping) {
      return;
    }
    // 只索引消息到达的元数据，不记录消息内容；且只针对当前已认证账号下启用的群。
    if (event && typeof event === 'object') {
      const raw = event as Record<string, unknown>,
        groupId = id(raw.group_id);
      if (
        raw.post_type === 'message' &&
        raw.message_type === 'group' &&
        id(raw.self_id) === selfId &&
        groupId &&
        (enabledGroups.get(groupId) ?? app.defaultsEnabled) &&
        id(raw.user_id) !== selfId
      ) {
        log('debug', 'onebot.message_received', {
          group_id: groupId,
          message_id: raw.message_id,
        });
      }
    }
    void router
      .receive(event, selfId)
      .catch(() =>
        log('warn', 'message.failed', { reason: 'event_handler_failed' }),
      );
  };
  client.on('message', receive);
  client.on('notice', receive);
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(heartbeat);
    clearInterval(sandboxPulse);
    unsubscribeSandbox();
    log('info', 'app.stopping');
    const remindersStopping = reminderScheduler?.stop();
    const sandboxStopping = sandboxService?.stop();
    const groupsStopping = router.stop();
    scheduler.close();
    void Promise.allSettled([
      groupsStopping,
      client.stop(),
      remindersStopping,
      sandboxStopping,
      sandboxFlush,
    ])
      .then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          log('error', 'app.shutdown_failed', { reason: 'operation_failed' });
          process.exitCode = 1;
        } else {
          log('info', 'app.stopped');
        }
      })
      .finally(async () => {
        try {
          artifactStore?.close();
        } catch {
          log('warn', 'app.artifact_close_failed', { reason: 'close_failed' });
        }
        try {
          sandboxStore?.close();
        } catch {
          log('warn', 'app.sandbox_close_failed', { reason: 'close_failed' });
        }
        try {
          reminderStore?.close();
        } catch {
          log('warn', 'app.reminders_close_failed', { reason: 'close_failed' });
        }
        try {
          customFaceCoordinator?.close();
        } catch {
          log('warn', 'app.custom_faces_close_failed', {
            reason: 'close_failed',
          });
        }
        try {
          customFaceStore?.close();
        } catch {
          log('warn', 'app.custom_faces_close_failed', {
            reason: 'close_failed',
          });
        }
        try {
          registry?.close();
        } catch {
          log('warn', 'app.registry_failed', { reason: 'close_failed' });
        }
        try {
          toolObservations?.close();
        } catch {
          log('warn', 'app.tool_observations_unavailable', {
            reason: 'close_failed',
          });
        }
        try {
          telemetry?.close();
        } catch {
          log('warn', 'model.telemetry_failed', { reason: 'close_failed' });
        }
        stopObserving?.();
        try {
          runtimeEvents?.close();
        } catch {}
        await logger?.close();
        process.exit(process.exitCode ?? 0);
      });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  client.start();
}

void main().catch(async (error: unknown) => {
  try {
    reminderStore?.close();
  } catch {}
  try {
    customFaceCoordinator?.close();
  } catch {}
  try {
    customFaceStore?.close();
  } catch {}
  try {
    registry?.close();
  } catch {}
  try {
    toolObservations?.close();
  } catch {}
  try {
    telemetry?.close();
  } catch {}
  clearInterval(heartbeat);
  if (logger) {
    log('error', 'app.startup_failed', { reason: 'startup_failed' });
    stopObserving?.();
    try {
      runtimeEvents?.close();
    } catch {}
    await logger.close();
  } else {
    console.error(
      error instanceof ConfigError
        ? error.message
        : 'Listener startup failed; details suppressed to protect secrets',
    );
  }
  process.exitCode = 1;
  process.exit(1);
});

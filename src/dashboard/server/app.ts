import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGzip, gzipSync } from 'node:zlib';
import {
  Repository,
  ResourceLimit,
  summarize,
  type Sources,
} from './repository.ts';
import { registerReviewRoutes } from './review-routes.ts';
import { ReviewRepository } from './review-repository.ts';
import { buildRequestTrends } from './request-trends.ts';
import { RequestTrendsSync } from './request-trends-sync.ts';
import { registerResourceSync } from './resource-sync.ts';
import { internalToolObservations } from './tool-observations.ts';
import { TOOL_USAGE_ROLE_VERSION } from '../contracts/tool-observations.ts';
import { isIP } from 'node:net';
import { type AuthStore, sessionToken } from './auth.ts';
import { authWrites, registerAuthRoutes } from './auth-routes.ts';
import {
  DAY,
  InvalidQuery,
  MAX_OFFSET,
  cursorOffset,
  detailId,
  encodeCursor,
  onlyKeys,
  pageLimit,
  queryBinding,
  searchText,
  timeRange,
  type Query,
} from './query.ts';

export interface AppOptions extends Sources {
  /** 运行时必填，缺失时直接拒绝启动。store的生命周期由调用方管理。 */
  auth?: AuthStore;
  webRoot?: string;
  now?: () => number;
  /** 监听地址，用于校验Host头；默认只允许loopback。 */
  listenHost?: string;
}

/** Host头白名单，防御DNS rebinding：只接受loopback、监听地址，或监听全部地址时的IP字面量。 */
function allowedHost(host: string, listenHost = '127.0.0.1') {
  try {
    const u = new URL(`http://${host}`);
    return (
      !u.username &&
      !u.password &&
      u.pathname === '/' &&
      (['localhost', '127.0.0.1', '[::1]', listenHost].includes(u.hostname) ||
        u.hostname === `[${listenHost}]` ||
        (['0.0.0.0', '::'].includes(listenHost) &&
          isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0)) &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

const COMPRESS_MIN_BYTES = 1024;

/** 构建只读dashboard服务：除登录/登出外只允许GET/HEAD，所有/api路径都要求认证。 */
export function buildApp(options: AppOptions) {
  const auth = options.auth;
  if (!auth) {
    throw new Error('Dashboard authentication store required');
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 1024,
    requestTimeout: 10000,
  });
  const repository = new Repository(options);
  const reviewRepository = new ReviewRepository(repository);
  const now = options.now ?? Date.now;
  app.addHook('onClose', async () => repository.close());
  // 趋势快照和图表脚本都有数百KB；反向代理不一定压缩，这里对文本类响应做gzip。
  app.addHook('onSend', async (req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (
      req.method === 'HEAD' ||
      reply.getHeader('content-encoding') ||
      !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) ||
      !/^(?:application\/(?:json|javascript)|text\/|image\/svg)/.test(type)
    ) {
      return payload;
    }
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      if (Buffer.byteLength(payload) < COMPRESS_MIN_BYTES) {
        return payload;
      }
      reply
        .header('Content-Encoding', 'gzip')
        .header('Vary', 'Accept-Encoding')
        .removeHeader('content-length');
      return gzipSync(payload);
    }
    const length = Number(reply.getHeader('content-length'));
    if (
      payload instanceof Readable &&
      !(Number.isFinite(length) && length < COMPRESS_MIN_BYTES)
    ) {
      reply
        .header('Content-Encoding', 'gzip')
        .header('Vary', 'Accept-Encoding')
        .removeHeader('content-length');
      return payload.pipe(createGzip());
    }
    return payload;
  });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
    const host = req.headers.host;
    const authWrite = req.method === 'POST' && authWrites.has(req.url);
    const safeRead = req.method === 'GET' || req.method === 'HEAD';
    if (
      !host ||
      !allowedHost(host, options.listenHost) ||
      // 只接受origin-form；路由器也能识别absolute-form，但不能让路径分类与路由不一致。
      !req.url.startsWith('/') ||
      (!safeRead && !authWrite)
    ) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Read-only access from configured host required',
      });
    }
    const path = req.url.split('?')[0]!;
    // 与API鉴权共用分类，编码/大小写变体及无法解码的路径不能借导航例外放行。
    let decoded: string;
    try {
      decoded = decodeURIComponent(path).toLowerCase();
    } catch {
      decoded = '/api/';
    }
    const apiPath = decoded === '/api' || decoded.startsWith('/api/');
    // 安卓安装应用的外部启动可能是cross-site顶层导航。公开页面仅允许
    // 顶层导航跨站读取；安装素材可公开读取，所有API仍保留跨站限制。
    const publicRead =
      safeRead &&
      !apiPath &&
      ((req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document') ||
        path === '/manifest.webmanifest' ||
        /^\/icons\/[a-z0-9-]+\.png$/.test(path));
    if (req.headers['sec-fetch-site'] === 'cross-site' && !publicRead) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Cross-site access denied' });
    }
    if (authWrite && !req.headers.origin) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Same-origin access required' });
    }
    if (req.headers.origin && !publicRead) {
      let origin: URL;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Invalid origin' });
      }
      if (
        origin.origin !== `${auth.secureCookie ? 'https' : 'http'}://${host}` ||
        req.headers.origin !== origin.origin
      ) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Same-origin access required' });
      }
    }
    const publicAuth =
      (safeRead && path === '/api/auth/session') ||
      (authWrite &&
        (req.url === '/api/auth/login' || req.url === '/api/auth/logout'));
    if (apiPath && !publicAuth) {
      if (!auth.configured) {
        return reply.code(503).send({
          error: auth.configurationError,
          message: 'Set DASHBOARD_PASSWORD in .env and restart the dashboard',
        });
      }
      if (!auth.authenticated(sessionToken(req.headers.cookie))) {
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'Sign in required' });
      }
    }
  });
  registerAuthRoutes(app, auth);
  app.setErrorHandler((error, _req, reply) => {
    if (
      error instanceof InvalidQuery ||
      (error instanceof Error && 'validation' in error && error.validation)
    ) {
      return reply
        .code(400)
        .send({ error: 'invalid_query', message: 'Invalid query parameters' });
    }
    if (
      error instanceof Error &&
      'statusCode' in error &&
      [403, 404].includes(Number(error.statusCode))
    ) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    }
    if (error instanceof ResourceLimit) {
      return reply.code(503).send({
        error: 'unavailable',
        message: 'Query exceeds resource limit; select a narrower time range',
      });
    }
    return reply
      .code(503)
      .send({ error: 'unavailable', message: 'Data temporarily unavailable' });
  });
  const parse = (value: unknown, extra: string[] = []) => {
    repository.refreshGroups();
    const q = value as Query;
    onlyKeys(q, ['since', 'until', 'groupId', ...extra]);
    const range = timeRange(q, now());
    let groupId: string | undefined;
    if (q.groupId !== undefined) {
      if (
        typeof q.groupId !== 'string' ||
        !repository.groups.some((g) => g.groupId === q.groupId)
      ) {
        throw new InvalidQuery();
      }
      groupId = q.groupId;
    }
    return { range, groupId, q };
  };
  app.get('/api/meta', async (req) => {
    repository.refreshGroups();
    if (Object.keys(req.query as object).length) {
      throw new InvalidQuery();
    }
    return {
      groups: repository.groups.map((g) => ({ groupId: g.groupId })),
      models: [...(options.models ?? [])],
      readOnly: true,
      maxRangeDays: 31,
      now: now(),
      availability: repository.availability(),
    };
  });
  const trendsSync = new RequestTrendsSync(reviewRepository, now);
  app.get('/api/request-trends/sync', async (req) => {
    const { range, groupId, q } = parse(req.query, ['cursor']);
    // 同步cursor绑定到当前登录会话，只传token的哈希。
    const fingerprint = createHash('sha256')
      .update(sessionToken(req.headers.cookie) ?? '')
      .digest('hex');
    return trendsSync.sync(range, groupId, q.cursor, fingerprint);
  });
  app.get('/api/request-trends', async (req) => {
    const { range, groupId } = parse(req.query);
    const requests = reviewRepository.requests(range, groupId);
    return buildRequestTrends(range, repository.availability(), requests);
  });
  app.get('/api/overview', async (req) => {
    const { range, groupId } = parse(req.query),
      requests = reviewRepository.requests(range, groupId),
      rows = requests.map((r) => ({
        model_name: r.modelName,
        interval_known: r.performance.coverage.modelIntervalRequests === 1,
        request_id: r.requestId,
        group_id: r.groupId,
        started_at: r.startedAt,
        ended_at: r.endedAt,
        duration_ms: r.durationMs,
        status: r.status,
        error_code: r.errorCode,
        input_tokens: r.totalInputTokens,
        cached_input_tokens: r.cachedInputTokens,
        output_tokens: r.outputTokens,
        ttft_ms: r.ttftMs,
        decode_duration_ms: r.decodeDurationMs,
      })),
      toolRows = repository.toolTimings(range, groupId),
      bucket = range.until - range.since <= 2 * DAY ? 3600000 : DAY;
    const series = [];
    for (
      let start = Math.floor(range.since / bucket) * bucket;
      start <= range.until;
      start += bucket
    ) {
      series.push({
        bucketStart: start,
        ...summarize(
          rows.filter(
            (r) => r.started_at >= start && r.started_at < start + bucket,
          ),
          toolRows.filter(
            (t) => t.proposed_at >= start && t.proposed_at < start + bucket,
          ),
        ),
      });
    }
    return {
      range,
      availability: repository.availability(),
      summary: summarize(rows, toolRows),
      series,
      groups: repository.groups
        .filter((g) => !groupId || g.groupId === groupId)
        .map((g) => ({
          groupId: g.groupId,
          ...summarize(
            rows.filter((r) => r.group_id === g.groupId),
            toolRows.filter((t) => t.group_id === g.groupId),
          ),
        })),
      // 工具耗时无法归属到单个模型，按模型汇总时不计入。
      models: [...new Set(rows.map((r) => r.model_name))]
        .sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
        .map((modelName) => ({
          modelName,
          ...summarize(rows.filter((r) => r.model_name === modelName)),
        })),
    };
  });
  app.get('/api/wakes', async (req) => {
    const { range, groupId, q } = parse(req.query, [
        'limit',
        'cursor',
        'q',
        'outcome',
      ]),
      limit = pageLimit(q, 30),
      text = searchText(q);
    if (
      q.outcome !== undefined &&
      (typeof q.outcome !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(q.outcome))
    ) {
      throw new InvalidQuery();
    }
    const binding = queryBinding({
      range,
      groupId,
      q: text,
      outcome: q.outcome,
      groups: repository.groups
        .filter((g) => !groupId || g.groupId === groupId)
        .map((g) => g.groupId)
        .sort(),
    });
    const offset = cursorOffset(q.cursor, binding);
    const { items, hasMore } = repository.wakes(range, groupId, offset, limit, {
      q: text,
      outcome: q.outcome as string | undefined,
    });
    if (hasMore && offset + limit > MAX_OFFSET) {
      throw new ResourceLimit();
    }
    return {
      range,
      availability: repository.availability(),
      items: items.map((item) => reviewRepository.wakeSummary(item)),
      nextCursor: hasMore
        ? encodeCursor(binding, { offset: offset + limit })
        : null,
    };
  });
  app.get('/api/wakes/:id', async (req, reply) => {
    repository.refreshGroups();
    const q = req.query as Query;
    onlyKeys(q, ['groupId']);
    const id = detailId((req.params as { id?: unknown }).id, 128);
    if (
      typeof q.groupId !== 'string' ||
      !repository.groups.some((g) => g.groupId === q.groupId)
    ) {
      throw new InvalidQuery();
    }
    if (!repository.session(q.groupId)) {
      return reply
        .code(503)
        .send({ error: 'unavailable', message: 'Session data unavailable' });
    }
    const detail = repository.detail(q.groupId, id);
    if (detail) {
      detail.wake = reviewRepository.wakeSummary(detail.wake);
    }
    return (
      detail ??
      reply.code(404).send({ error: 'not_found', message: 'Wake not found' })
    );
  });
  app.get('/api/tools', async (req) => {
    const { range, groupId } = parse(req.query);
    return {
      range,
      availability: repository.availability(),
      items: repository.tools(range, groupId),
      internal: internalToolObservations(repository, range, groupId),
      toolUsageRoleVersion: TOOL_USAGE_ROLE_VERSION,
    };
  });
  registerReviewRoutes(app, repository, now);
  registerResourceSync(app, repository, now);
  if (options.webRoot && existsSync(options.webRoot)) {
    app.register(fastifyStatic, {
      root: options.webRoot,
      index: ['index.html'],
      dotfiles: 'deny',
      cacheControl: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.includes('.')) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }
  return app;
}

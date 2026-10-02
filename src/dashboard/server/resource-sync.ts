import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sessionToken } from './auth.ts';
import { TOOL_OBSERVATION_SCHEMA_VERSION } from '../../contracts/tool-observation.ts';
import { TOOL_USAGE_ROLE_VERSION } from '../contracts/tool-observations.ts';
import { type Repository } from './repository.ts';
import {
  RESOURCE_SYNC_MAX_PAYLOAD_BYTES,
  type ResourcePatch,
  type ResourceSyncResponse,
} from '../contracts/resource-sync.ts';

export const RESOURCE_SYNC_TTL_MS = 5 * 60_000;
export const RESOURCE_SYNC_MAX_ENTRIES = 64;
const RESOURCE_SYNC_MAX_CACHE_BYTES = 16 * 1024 * 1024;

type State = {
  session: string;
  policy: string;
  scope: string;
  resource: string;
  since: number | null;
  until: number | null;
  version: string | null;
  data: unknown;
  bytes: number;
  expires: number;
};

const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** 有界的结构化差分，未变化的字符串不会被复制进patch；超过4096条操作时抛错。 */
function diff(
  before: unknown,
  after: unknown,
  path = '',
  out: ResourcePatch[] = [],
): ResourcePatch[] {
  if (before === after) {
    return out;
  }
  if (out.length > 4096) {
    throw new Error('patch_limit');
  }
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    if (Array.isArray(before) && Array.isArray(after)) {
      for (let i = before.length - 1; i >= after.length; i--) {
        out.push({ op: 'remove', path: `${path}/${i}` });
      }
      for (let i = 0; i < after.length; i++) {
        if (i >= before.length) {
          out.push({ op: 'add', path: `${path}/${i}`, value: after[i] });
        } else {
          diff(before[i], after[i], `${path}/${i}`, out);
        }
      }
    } else {
      const from = before as Record<string, unknown>;
      const to = after as Record<string, unknown>;
      for (const key of Object.keys(from)) {
        if (!Object.hasOwn(to, key)) {
          out.push({ op: 'remove', path: `${path}/${escape(key)}` });
        }
      }
      for (const key of Object.keys(to)) {
        if (!Object.hasOwn(from, key)) {
          out.push({
            op: 'add',
            path: `${path}/${escape(key)}`,
            value: to[key],
          });
        } else {
          diff(from[key], to[key], `${path}/${escape(key)}`, out);
        }
      }
    }
  } else {
    out.push({ op: 'replace', path, value: after });
  }
  if (out.length > 4096) {
    throw new Error('patch_limit');
  }
  return out;
}

/** 校验并规范化resource参数：只接受白名单内的/api路径，拒绝重复的query键，并对query排序。 */
function resourceURL(raw: unknown) {
  if (
    typeof raw !== 'string' ||
    raw.length > 8192 ||
    !raw.startsWith('/api/') ||
    /[\x00-\x20#\\]/.test(raw)
  ) {
    return null;
  }
  const url = new URL(raw, 'http://localhost');
  if (url.origin !== 'http://localhost' || url.pathname !== raw.split('?')[0]) {
    return null;
  }
  if (
    !/^\/api\/(?:meta|overview|health|requests|wakes|tools|events)$/.test(
      url.pathname,
    ) &&
    !/^\/api\/(?:requests\/[^/]+|wakes\/[^/]+(?:\/review)?|javascript-jobs\/[^/]+\/links)$/.test(
      url.pathname,
    )
  ) {
    return null;
  }
  // 编码后的路径分隔符和路径穿越不能绕过白名单。
  try {
    if (
      decodeURIComponent(url.pathname)
        .split('/')
        .some((p) => p === '.' || p === '..') ||
      /%2f|%5c/i.test(url.pathname)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) {
    return null;
  }
  url.searchParams.sort();
  return url;
}

/**
 * 注册/api/resource-sync：通过内部inject请求原有GET路由，并按cursor返回snapshot、patch或unchanged。
 * 缓存按会话、授权策略和资源范围隔离，并受条目数与总字节数限制。
 */
export function registerResourceSync(
  app: FastifyInstance,
  base: Repository,
  now: () => number,
): void {
  const cache = new Map<string, State>();
  let cacheBytes = 0;
  const drop = (key: string) => {
    const s = cache.get(key);
    if (s) {
      cacheBytes -= s.bytes;
    }
    cache.delete(key);
  };
  const clearSession = (session: string) => {
    for (const [key, s] of cache) {
      if (s.session === session) {
        drop(key);
      }
    }
  };
  app.addHook('onClose', async () => {
    cache.clear();
    cacheBytes = 0;
  });
  app.get('/api/resource-sync', async (req, reply): Promise<unknown> => {
    const q = req.query as Record<string, unknown>;
    const session = createHash('sha256')
      .update(sessionToken(req.headers.cookie) ?? '')
      .digest('hex');
    const fail = () => {
      clearSession(session);
      return reply.code(400).send({
        error: 'invalid_query',
        message: 'Invalid resource sync parameters',
      });
    };
    const url = resourceURL(q.resource);
    if (
      !url ||
      Object.keys(q).some((k) => !['resource', 'cursor'].includes(k)) ||
      (q.cursor !== undefined &&
        (typeof q.cursor !== 'string' || q.cursor.length > 128))
    ) {
      return fail();
    }
    const time = now();
    for (const [key, s] of cache) {
      if (s.expires <= time) {
        drop(key);
      }
    }
    // 即使轮询结果未变化，也必须重新检查动态权限。
    base.refreshGroups();
    const policy = createHash('sha256')
      .update(
        JSON.stringify([
          base.groups,
          base.sources.telemetryPath,
          base.sources.inspectionSecrets ?? [],
          TOOL_OBSERVATION_SCHEMA_VERSION,
          TOOL_USAGE_ROLE_VERSION,
        ]),
      )
      .digest('hex');
    for (const s of cache.values()) {
      if (s.session === session && s.policy !== policy) {
        clearSession(session);
        break;
      }
    }
    const group = url.searchParams.get('groupId');
    if (group !== null && !base.groups.some((g) => g.groupId === group)) {
      return fail();
    }
    const resource = url.pathname + url.search;
    const explicit = ['since', 'until'].every(
      (k) =>
        /^\d{1,16}$/.test(url.searchParams.get(k) ?? '') &&
        Number.isSafeInteger(Number(url.searchParams.get(k))),
    );
    const since = explicit ? Number(url.searchParams.get('since')) : null;
    const until = explicit ? Number(url.searchParams.get('until')) : null;
    const scopeURL = new URL(url);
    if (explicit) {
      scopeURL.searchParams.delete('since');
      scopeURL.searchParams.delete('until');
    }
    const scope = scopeURL.pathname + scopeURL.search;
    const candidate =
      typeof q.cursor === 'string' ? cache.get(q.cursor) : undefined;
    const previous =
      candidate &&
      candidate.session === session &&
      candidate.policy === policy &&
      candidate.scope === scope &&
      (candidate.resource === resource ||
        (since !== null &&
          until !== null &&
          candidate.since !== null &&
          candidate.until !== null &&
          since >= candidate.since &&
          until - since === candidate.until - candidate.since))
        ? candidate
        : undefined;
    // 隐式/滑动时间范围和health的租约状态无法靠数据库版本证明未变化。
    const temporal =
      ['/api/meta', '/api/health'].includes(url.pathname) ||
      (!explicit && !/^\/api\/(requests|wakes)\//.test(url.pathname));
    const version = base.resourceVersion();
    if (
      previous &&
      !temporal &&
      previous.resource === resource &&
      version !== null &&
      previous.version === version
    ) {
      previous.expires = time + RESOURCE_SYNC_TTL_MS;
      return { mode: 'unchanged', cursor: q.cursor };
    }
    // 通过内部inject复用原路由的认证、查询校验、投影上限和错误处理。
    const response = await app.inject({
      method: 'GET',
      url: resource,
      headers: {
        host: req.headers.host!,
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      },
    });
    if (response.statusCode !== 200) {
      clearSession(session);
      return reply
        .code(response.statusCode)
        .type('application/json')
        .send(response.body);
    }
    // 请求期间授权若发生变化，丢弃结果，避免把旧授权下的数据缓存下来。
    base.refreshGroups();
    const afterPolicy = createHash('sha256')
      .update(
        JSON.stringify([
          base.groups,
          base.sources.telemetryPath,
          base.sources.inspectionSecrets ?? [],
          TOOL_OBSERVATION_SCHEMA_VERSION,
          TOOL_USAGE_ROLE_VERSION,
        ]),
      )
      .digest('hex');
    if (policy !== afterPolicy) {
      clearSession(session);
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Resource permissions changed; retry',
      });
    }
    if (Buffer.byteLength(response.body) > RESOURCE_SYNC_MAX_PAYLOAD_BYTES) {
      // 超大的详情不能挤掉本会话中其他无关资源的缓存。
      if (previous && typeof q.cursor === 'string') {
        drop(q.cursor);
      }
      // 保留原有详情的大小预算，不在patch缓存中保存或复制大体积内容，这类资源直接退回snapshot。
      return {
        mode: 'snapshot',
        cursor: randomBytes(32).toString('hex'),
        data: JSON.parse(response.body),
      } satisfies ResourceSyncResponse;
    }
    const afterVersion = base.resourceVersion();
    const data: unknown = JSON.parse(response.body);
    const cursor = randomBytes(32).toString('hex');
    let result: ResourceSyncResponse = { mode: 'snapshot', cursor, data };
    if (previous) {
      try {
        const patch = diff(previous.data, data);
        if (!patch.length) {
          result = { mode: 'unchanged', cursor };
        } else if (
          Buffer.byteLength(JSON.stringify(patch)) <
          Buffer.byteLength(response.body)
        ) {
          result = { mode: 'patch', cursor, patch };
        }
      } catch {
        // 结构变化过大时退回有界的snapshot。
      }
    }
    // 作废旧cursor：并发重放可能因此退回snapshot，但绝不会应用错误的patch。
    if (previous && typeof q.cursor === 'string') {
      drop(q.cursor);
    }
    const bytes =
      Buffer.byteLength(response.body) +
      Buffer.byteLength(
        resource + scope + policy + session + (afterVersion ?? ''),
      ) +
      512;
    cache.set(cursor, {
      session,
      policy,
      scope,
      resource,
      since,
      until,
      // 请求前后版本不一致说明期间有写入，不记录版本，下次必须重新读取。
      version: version !== null && version === afterVersion ? version : null,
      data,
      bytes,
      expires: time + RESOURCE_SYNC_TTL_MS,
    });
    cacheBytes += bytes;
    while (
      cache.size > RESOURCE_SYNC_MAX_ENTRIES ||
      cacheBytes > RESOURCE_SYNC_MAX_CACHE_BYTES
    ) {
      drop(cache.keys().next().value!);
    }
    return result;
  });
}

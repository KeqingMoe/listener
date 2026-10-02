import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../../src/dashboard/server/app.ts';
import { AuthStore } from '../../../src/dashboard/server/auth.ts';
import { eventTitle } from '../../../src/dashboard/contracts/event-labels.ts';
import { Repository } from '../../../src/dashboard/server/repository.ts';
import { ReviewRepository } from '../../../src/dashboard/server/review-repository.ts';
import { TelemetryStore } from '../../../src/observability/telemetry.ts';
import { WorldEventStore } from '../../../src/world/events.ts';

function fixture(old = false) {
  const dir = mkdtempSync(join(tmpdir(), 'review-')),
    telemetryPath = join(dir, 't.sqlite'),
    sessionPath = join(dir, 's.sqlite');
  const db = new DatabaseSync(telemetryPath);
  db.exec(`CREATE TABLE model_requests(request_id TEXT PRIMARY KEY,group_id TEXT,turn_id TEXT,started_at INTEGER,ended_at INTEGER,duration_ms REAL,status TEXT,transport TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER,error_code TEXT);
 INSERT INTO model_requests VALUES('first','11','physical-turn',100,200,100,'success','responses',100,10,40,NULL),('cancel','11','physical-turn',300,400,100,'error','responses',NULL,NULL,NULL,'cancelled'),('foreign','22','physical-turn',100,200,100,'success','responses',900,90,0,NULL);`);
  if (!old) {
    db.exec(`CREATE TABLE model_request_inspections(request_id TEXT PRIMARY KEY,group_id TEXT,turn_id TEXT,wake_id TEXT,phase TEXT,started_at INTEGER,ended_at INTEGER,transport TEXT,model TEXT,status TEXT,request_json TEXT,response_json TEXT,reasoning_text TEXT,error_text TEXT,response_id TEXT,previous_response_id TEXT,provider_request_id TEXT,request_mode TEXT,content_truncated INTEGER DEFAULT 0);
 CREATE TABLE runtime_events(seq INTEGER PRIMARY KEY,observed_at INTEGER,event TEXT,group_id TEXT,turn_id TEXT,message_id TEXT,fields TEXT);
 INSERT INTO runtime_events VALUES(1,490,'app.heartbeat',NULL,NULL,NULL,'{}'),(2,480,'onebot.ready',NULL,NULL,NULL,'{}'),(3,350,'model.failed','11','physical-turn',NULL,'{"reason":"cancelled"}');`);
    const insert = db.prepare(
      'INSERT INTO model_request_inspections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    insert.run(
      'first',
      '11',
      'physical-turn',
      'wake-a',
      'model',
      100,
      200,
      'responses',
      'test-model',
      'success',
      JSON.stringify({
        input: [
          {
            role: 'user',
            content:
              'normal business text message_id=123 cursor=abc face_ref=face-1 key LIVE_SECRET',
          },
        ],
        Authorization: 'Bearer abc',
        password: 'pw',
        confirmation_code: 'confirm',
        image: 'data:image/png;base64,AAAA',
      }),
      '{"id":"resp-one","output":[]}',
      'visible reasoning',
      null,
      'resp-one',
      null,
      'provider-one',
      'new',
      0,
    );
    insert.run(
      'cancel',
      '11',
      'physical-turn',
      'wake-b',
      'model',
      300,
      400,
      'responses',
      'test-model',
      'error',
      '{"previous_response_id":"resp-one"}',
      null,
      null,
      'Cancelled normally',
      'resp-two',
      'resp-one',
      'provider-two',
      'continue',
      0,
    );
    insert.run(
      'foreign',
      '22',
      'physical-turn',
      'wake-a',
      'model',
      100,
      200,
      'responses',
      'foreign-model',
      'success',
      '{"private":"foreign body"}',
      null,
      null,
      null,
      'foreign-response',
      'resp-one',
      null,
      'new',
      0,
    );
  }
  db.close();
  const session = new DatabaseSync(sessionPath);
  session.exec(`CREATE TABLE model_session_meta(singleton INTEGER,group_id TEXT);INSERT INTO model_session_meta VALUES(1,'11');
 CREATE TABLE model_session_journal(seq INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT,kind TEXT,payload TEXT,created_at INTEGER);
 INSERT INTO model_session_journal VALUES(1,'session-a','wake-a','wake_begin','{}',90),(2,'session-a','wake-a','wake_finish','{"reason":"session_reset"}',210),(3,'session-b','wake-b','wake_begin','{}',290);
 CREATE TABLE model_session_messages(seq INTEGER,session_id TEXT,wake_id TEXT,request_id TEXT,message TEXT);
 CREATE TABLE model_tool_ledger(ordinal INTEGER,name TEXT,wake_id TEXT,state TEXT,arguments TEXT,result TEXT,proposed_at INTEGER,started_at INTEGER,finished_at INTEGER,assistant_seq INTEGER,call_id TEXT);`);
  const message = session.prepare(
    'INSERT INTO model_session_messages VALUES(?,?,?,?,?)',
  );
  message.run(
    1,
    'session-a',
    'wake-a',
    null,
    JSON.stringify({
      role: 'user',
      content: JSON.stringify({
        wake: {
          wake_id: 'physical-turn',
          trigger: { type: 'message', message_ids: ['123'] },
        },
      }),
    }),
  );
  message.run(
    2,
    'session-a',
    'wake-a',
    'first',
    JSON.stringify({ role: 'assistant', content: 'use read_messages' }),
  );
  message.run(
    3,
    'session-b',
    'wake-b',
    null,
    JSON.stringify({
      role: 'user',
      content: JSON.stringify({
        wake: { wake_id: 'physical-turn', trigger: { type: 'message' } },
      }),
    }),
  );
  session
    .prepare('INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      1,
      'read_messages',
      'wake-a',
      'finished',
      JSON.stringify({
        cursor: 'cursor-visible',
        message_id: '123',
        user_id: '100000001',
        reply_to: '9003',
        face_ref: 'face-visible',
        password: 'private-pw',
      }),
      JSON.stringify({
        status: 'ok',
        messages: ['actual readable content'],
        members: [{ user_id: '100000002' }, { user_id: '100000003' }],
        authorization: 'secret',
        cookie: 'sessioncookie',
      }),
      110,
      120,
      130,
      2,
      'call-one',
    );
  session.close();
  const worldPath = join(dir, 's.events.sqlite');
  if (!old) {
    const world = new WorldEventStore({ path: worldPath, groupId: '11' });
    const message = (id: string, userId: string, nickname: string) =>
      world.appendMessage({
        messageId: id,
        userId,
        nickname,
        text: 'x',
        time: 1,
        segments: [{ type: 'text', text: 'x' }],
      });
    message('9001', '100000001', '旧名');
    message('9002', '100000001', '新名');
    message('9003', '100000002', '100000002');
    world.close();
  }
  const auth = new AuthStore({
      path: join(dir, 'auth.sqlite'),
      password: 'test-password-long',
    }),
    login = auth.login('test-password-long', '127.0.0.1');
  assert.equal(login.status, 'ok');
  const cookie = `dashboard_session=${login.status === 'ok' ? login.token : ''}`;
  let groups = [{ groupId: '11', sessionPath, worldPath }];
  const app = buildApp({
    auth,
    telemetryPath,
    getGroups: () => groups,
    inspectionSecrets: ['LIVE_SECRET'],
    now: () => 500,
  });
  return {
    app,
    telemetryPath,
    sessionPath,
    worldPath,
    get: (url: string) => app.inject({ url, headers: { cookie } }),
    revoke: () => {
      groups = [];
    },
    cleanup: async () => {
      await app.close();
      auth.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('only trusted notification projection journal supplies task backlinks to a wake', async () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.sessionPath);
    const insert = db.prepare(
      'INSERT INTO model_session_journal VALUES(?,?,?,?,?,?)',
    );
    insert.run(
      10,
      'session-a',
      'wake-a',
      'external_event_received',
      JSON.stringify({ event_id: '10001:js_real' }),
      150,
    );
    insert.run(
      11,
      'session-a',
      'wake-a',
      'external_event_received',
      JSON.stringify({ event_id: '10001:js_LIVE_SECRET' }),
      151,
    );
    insert.run(
      12,
      'session-a',
      'wake-a',
      'tool_result',
      JSON.stringify({ event_id: '10001:js_wrong_kind' }),
      152,
    );
    insert.run(
      13,
      'session-a',
      'wake-a',
      'external_event_received',
      JSON.stringify({ event_id: 'untrusted:js_invalid' }),
      153,
    );
    db.prepare('INSERT INTO model_session_messages VALUES(?,?,?,?,?)').run(
      20,
      'session-a',
      'wake-a',
      null,
      JSON.stringify({
        role: 'user',
        content: JSON.stringify({
          host_event: { job_id: 'js_user_text', status: 'completed' },
        }),
      }),
    );
    db.close();
    const telemetry = new DatabaseSync(f.telemetryPath);
    telemetry
      .prepare('INSERT INTO runtime_events VALUES(?,?,?,?,?,?,?)')
      .run(
        20,
        154,
        'external_event_received',
        '11',
        'physical-turn',
        null,
        JSON.stringify({ event_id: '10001:js_runtime' }),
      );
    telemetry.close();
    const response = await f.get('/api/wakes/wake-a/review?groupId=11');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response
        .json()
        .events.filter(
          (event: { javascriptJobId?: string }) => event.javascriptJobId,
        )
        .map((event: { javascriptJobId: string }) => event.javascriptJobId),
      ['js_real'],
    );
    assert.ok(!response.body.includes('LIVE_SECRET'));
  } finally {
    await f.cleanup();
  }
});

test('real TelemetryStore restart recovery time is not an interrupted HTTP end or model duration', async () => {
  const f = fixture(),
    telemetryPath = f.telemetryPath + '.real',
    now = Date.now(),
    started = now - 3 * 3600000;
  const groups = [{ groupId: '11', sessionPath: f.sessionPath }];
  const auth = new AuthStore({
      path: f.telemetryPath + '.auth',
      password: 'test-password-long',
    }),
    login = auth.login('test-password-long', '127.0.0.1');
  assert.equal(login.status, 'ok');
  const app = buildApp({ auth, telemetryPath, groups });
  const base = new Repository({ telemetryPath, groups });
  const get = (url: string) =>
    app.inject({
      url,
      headers: {
        cookie: `dashboard_session=${login.status === 'ok' ? login.token : ''}`,
      },
    });
  let store: TelemetryStore | undefined;
  try {
    store = new TelemetryStore(telemetryPath);
    store.beginRequest({
      requestId: 'orphan',
      groupId: '11',
      turnId: 'recovery-turn',
      wakeId: 'wake-recovery',
      startedAt: started,
      transport: 'responses',
      model: 'test',
      requestJson: '{}',
      requestMode: 'fresh',
    });
    store.close();
    store = new TelemetryStore(telemetryPath);
    store.beginRequest({
      requestId: 'after-restart',
      groupId: '11',
      turnId: 'new-turn',
      wakeId: 'new-wake',
      startedAt: now,
      transport: 'responses',
      model: 'test',
      requestJson: '{}',
      requestMode: 'fresh',
    });
    store.record({
      requestId: 'measured',
      groupId: '11',
      turnId: 'recovery-turn',
      wakeId: 'wake-recovery',
      startedAt: started + 1000,
      endedAt: started + 1100,
      durationMs: 100,
      transport: 'responses',
      model: 'test',
      status: 'success',
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    });
    store.close();
    store = undefined;
    const raw = new DatabaseSync(telemetryPath, { readOnly: true });
    const orphan = raw
      .prepare(
        "SELECT status,started_at,ended_at FROM model_request_inspections WHERE request_id='orphan'",
      )
      .get()!;
    assert.equal(orphan.status, 'interrupted');
    assert.ok(Number(orphan.ended_at) >= now);
    assert.ok(
      Number(orphan.ended_at) - Number(orphan.started_at) >= 3 * 3600000,
    );
    assert.equal(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM model_requests WHERE request_id='orphan'",
        )
        .get()!.n,
      0,
    );
    raw.close();
    const session = new DatabaseSync(f.sessionPath);
    session
      .prepare('INSERT INTO model_session_journal VALUES(?,?,?,?,?,?)')
      .run(
        4,
        'recovery-session',
        'wake-recovery',
        'wake_begin',
        '{}',
        started - 10,
      );
    session
      .prepare('INSERT INTO model_session_journal VALUES(?,?,?,?,?,?)')
      .run(
        5,
        'recovery-session',
        'wake-recovery',
        'wake_finish',
        '{"reason":"cancelled"}',
        now,
      );
    session.close();
    const review = new ReviewRepository(base),
      request = review.requests(undefined, '11', 'orphan')[0]!;
    assert.equal(request.status, 'interrupted');
    assert.equal(request.endedAt, null);
    assert.equal(request.durationMs, null);
    assert.equal(request.performance.modelDurationMs, null);
    assert.equal(request.performance.coverage.endedRequests, 0);
    assert.equal(request.performance.coverage.modelIntervalRequests, 0);
    const exact = (await get('/api/requests/orphan?groupId=11')).json().request;
    assert.equal(exact.endedAt, null);
    assert.equal(exact.durationMs, null);
    const range = `since=${started - 10}&until=${started + 2000}`;
    const overviewResponse = await get(`/api/overview?${range}`);
    assert.equal(overviewResponse.statusCode, 200);
    const summary = overviewResponse.json().summary;
    assert.equal(summary.requests, 2);
    assert.equal(summary.interrupted, 1);
    assert.equal(summary.performance.modelDurationMs, 100);
    assert.equal(summary.performance.coverage.modelDurationRequests, 1);
    assert.equal(summary.performance.coverage.endedRequests, 1);
    assert.equal(summary.tps, null);
    assert.equal(summary.ttftMs, null);
    const list = (await get(`/api/wakes?${range}`)).json();
    assert.equal(list.items.length, 1);
    const detail = (
      await get('/api/wakes/wake-recovery/review?groupId=11')
    ).json();
    for (const wake of [list.items[0], detail.wake]) {
      assert.equal(wake.modelRequests, 2);
      assert.equal(wake.performance.modelDurationMs, 100);
      assert.equal(wake.performance.modelWallDurationMs, null);
      assert.equal(wake.performance.otherDurationMs, null);
      assert.equal('roundTps' in wake.performance, false);
      assert.equal(wake.performance.coverage.endedRequests, 1);
    }
    // 即使带有合成的interrupted状态，主测量记录仍然可用。
    const update = new DatabaseSync(telemetryPath);
    update.exec(
      "UPDATE model_requests SET status='interrupted' WHERE request_id='measured'",
    );
    update.close();
    const measured = review.requests(undefined, '11', 'measured')[0]!;
    assert.equal(measured.status, 'interrupted');
    assert.equal(measured.endedAt, started + 1100);
    assert.equal(measured.durationMs, 100);
  } finally {
    store?.close();
    base.close();
    await app.close();
    auth.close();
    await f.cleanup();
  }
});

test('SQLite missing request start never turns DTO display zero into epoch-sized wake timing', async () => {
  const f = fixture();
  try {
    const epoch = 1700000000000;
    const db = new DatabaseSync(f.telemetryPath);
    db.prepare(
      'INSERT INTO model_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'missing-start',
      '11',
      'missing-start-turn',
      null,
      epoch + 100,
      null,
      'success',
      'responses',
      100,
      100,
      0,
      null,
    );
    db.prepare(
      'INSERT INTO model_request_inspections(request_id,group_id,turn_id,wake_id,started_at,ended_at,status) VALUES(?,?,?,?,?,?,?)',
    ).run(
      'missing-start',
      '11',
      'missing-start-turn',
      'wake-missing-start',
      null,
      epoch + 100,
      'success',
    );
    db.close();
    const session = new DatabaseSync(f.sessionPath);
    session
      .prepare('INSERT INTO model_session_journal VALUES(?,?,?,?,?,?)')
      .run(
        4,
        'missing-session',
        'wake-missing-start',
        'wake_begin',
        '{}',
        epoch,
      );
    session
      .prepare('INSERT INTO model_session_journal VALUES(?,?,?,?,?,?)')
      .run(
        5,
        'missing-session',
        'wake-missing-start',
        'wake_finish',
        '{"reason":"completed"}',
        epoch + 500,
      );
    session.close();
    for (const duration of [null, 250]) {
      if (duration !== null) {
        const update = new DatabaseSync(f.telemetryPath);
        update
          .prepare('UPDATE model_requests SET duration_ms=? WHERE request_id=?')
          .run(duration, 'missing-start');
        update.close();
      }
      const requestResponse = await f.get(
        '/api/requests/missing-start?groupId=11',
      );
      assert.equal(requestResponse.statusCode, 200);
      const request = requestResponse.json().request;
      assert.equal(request.startedAt, 0);
      assert.equal(request.durationMs, duration);
      assert.equal(request.performance.modelDurationMs, duration);
      assert.equal(request.performance.coverage.modelIntervalRequests, 0);
      const response = await f.get(
        `/api/wakes?since=${epoch}&until=${epoch + 500}`,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().items.length, 1);
      const listWake = response.json().items[0];
      const reviewResponse = await f.get(
        '/api/wakes/wake-missing-start/review?groupId=11',
      );
      assert.equal(reviewResponse.statusCode, 200);
      const metaResponse = await f.get(
        '/api/wakes/wake-missing-start?groupId=11',
      );
      assert.equal(metaResponse.statusCode, 200);
      for (const wake of [
        listWake,
        reviewResponse.json().wake,
        metaResponse.json().wake,
      ]) {
        assert.equal(wake.modelRequests, 1);
        assert.equal(wake.performance.modelDurationMs, duration);
        assert.equal(wake.performance.tps, null);
        assert.equal(wake.performance.ttftMs, null);
        assert.equal(wake.tps, null);
        assert.equal(wake.performance.decodeDurationMs, null);
        assert.equal(
          wake.performance.coverage.modelDurationRequests,
          duration === null ? 0 : 1,
        );
        assert.equal(wake.performance.coverage.modelIntervalRequests, 0);
        assert.equal(wake.performance.wallDurationMs, 500);
        assert.equal(wake.performance.modelWallDurationMs, null);
        assert.equal(wake.performance.otherDurationMs, null);
        assert.equal('roundTps' in wake.performance, false);
        assert.equal(
          wake.performance.whyIncomplete,
          'active_or_missing_timestamps',
        );
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('performance DTO is consistent across request, wake and overview without rotation double counting', async () => {
  const f = fixture();
  try {
    const overview = (await f.get('/api/overview?since=0&until=500')).json();
    assert.equal(overview.summary.requests, 2);
    assert.equal(overview.summary.performance.modelDurationMs, 200);
    assert.equal(overview.summary.performance.tps, null);
    assert.equal(overview.summary.performance.decodeDurationMs, null);
    assert.equal(overview.summary.performance.toolDurationMs, 10);
    assert.equal(overview.summary.performance.wallDurationMs, null);
    assert.equal('roundTps' in overview.summary.performance, false);
    assert.equal(overview.summary.cacheHitRate, 0.4);
    const narrow = (await f.get('/api/overview?since=100&until=400')).json();
    assert.equal(narrow.summary.tps, overview.summary.tps);
    const list = (await f.get('/api/wakes?since=0&until=500')).json();
    const wake = list.items.find((w: any) => w.wakeId === 'wake-a');
    assert.equal(wake.performance.wallDurationMs, 120);
    assert.equal(wake.performance.modelDurationMs, 200);
    assert.equal(wake.performance.otherDurationMs, null);
    assert.equal('roundTps' in wake.performance, false);
    assert.equal(wake.performance.whyIncomplete, 'scope_crosses_wake');
    assert.equal(wake.performance.toolDurationMs, 10);
    assert.equal(wake.cacheHitRate, 0.4);
    const expanded = (
      await f.get('/api/wakes/wake-a/review?groupId=11')
    ).json();
    assert.deepEqual(expanded.wake.performance, wake.performance);
    const metadata = (await f.get('/api/wakes/wake-a?groupId=11')).json();
    assert.deepEqual(metadata.wake.performance, wake.performance);
    const single = (await f.get('/api/requests/first?groupId=11')).json()
      .request;
    assert.equal(single.performance.modelDurationMs, 100);
    assert.equal(single.performance.wallDurationMs, 100);
    assert.equal(single.performance.toolDurationMs, null);
    assert.equal(single.performance.otherDurationMs, null);
    assert.equal(single.cacheHitRate, 0.4);
    const db = new DatabaseSync(f.telemetryPath);
    db.exec(
      "INSERT INTO model_request_inspections(request_id,group_id,turn_id,wake_id,started_at,status) VALUES('active','11','other','wake-b',450,'running'),('interrupted','11','other','wake-b',460,'interrupted')",
    );
    db.close();
    const active = (await f.get('/api/overview?since=0&until=500')).json()
      .summary;
    assert.equal(active.requests, 4);
    assert.equal(active.running, 1);
    assert.equal(active.interrupted, 1);
    assert.equal(active.unknown, 0);
    assert.equal(active.performance.modelDurationMs, 200);
    assert.equal(active.performance.coverage.modelDurationRequests, 2);
  } finally {
    await f.cleanup();
  }
});

test('reply lookup accepts canonical signed and zero message IDs, retaining raw evidence', async () => {
  const f = fixture();
  try {
    const world = new WorldEventStore({ path: f.worldPath, groupId: '11' });
    for (const messageId of ['-42', '0', '43']) {
      world.appendMessage({
        messageId,
        userId: '100000002',
        nickname: '甲',
        text: messageId,
        time: 1,
        segments: [{ type: 'text', text: messageId }],
      });
    }
    world.close();
    const result = {
      messages: [{ reply_to: '-42' }, { reply_to: 0 }, { replyTo: '9003' }],
      invalid: ['-0', '00', '-042', ' 43', '9007199254740992'].map(
        (reply_to) => ({ reply_to }),
      ),
      aliases: [{ REPLY_TO: '43' }, { replyto: '43' }],
    };
    const db = new DatabaseSync(f.sessionPath);
    db.prepare('UPDATE model_tool_ledger SET arguments=?, result=?').run(
      '{}',
      JSON.stringify(result),
    );
    db.close();
    const response = await f.get('/api/requests/first?groupId=11');
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(Object.keys(body.quotedMessages).sort(), [
      '-42',
      '0',
      '9003',
    ]);
    assert.equal(body.quotedMessages['-42'].text, '-42');
    assert.equal(body.quotedMessages['0'].text, '0');
    assert.deepEqual(body.tools[0].result, result);
  } finally {
    await f.cleanup();
  }
});

test('authorized review exposes business context, exact tool linkage and Responses chain while protecting credentials', async () => {
  const f = fixture();
  try {
    assert.equal((await f.app.inject('/api/requests')).statusCode, 401);
    const response = await f.get('/api/requests/first?groupId=11');
    assert.equal(response.statusCode, 200);
    const b = response.json();
    assert.equal(b.request.inputTokens, 60);
    assert.equal(b.request.totalInputTokens, 100);
    assert.equal(b.request.cachedInputTokens, 40);
    assert.equal(b.request.tps, null);
    assert.equal(b.request.ttftMs, null);
    assert.equal(b.request.providerRequestId, 'provider-one');
    assert.equal(b.tools[0].requestId, 'first');
    assert.equal(b.tools[0].callId, 'call-one');
    assert.equal(b.tools[0].arguments.cursor, 'cursor-visible');
    assert.equal(b.tools[0].arguments.face_ref, 'face-visible');
    assert.deepEqual(b.tools[0].result.messages, ['actual readable content']);
    // 最近一次观测的名字；名字等于QQ号或从未出现的成员不列出。
    assert.deepEqual(b.memberNames, { 100000001: '新名' });
    assert.deepEqual(b.quotedMessages, {
      9003: {
        userId: '100000002',
        nickname: '100000002',
        text: 'x',
        segments: [{ type: 'text', text: 'x' }],
      },
    });
    assert.equal(b.reasoningText, 'visible reasoning');
    assert.equal(b.errorText, null);
    assert.equal(b.nextRequests[0].requestId, 'cancel');
    assert.equal(b.nextRequests.length, 1);
    assert.match(response.body, /normal business text/);
    assert.doesNotMatch(
      response.body,
      /LIVE_SECRET|private-pw|sessioncookie|Bearer abc|base64,AAAA|foreign body/,
    );
    const cancel = (await f.get('/api/requests/cancel?groupId=11')).json();
    assert.equal(cancel.request.outcome, 'cancelled');
    assert.equal(cancel.request.tps, null);
    assert.equal(cancel.previousRequest.requestId, 'first');
    assert.equal(cancel.request.wakeId, 'wake-b');
    assert.equal(
      (await f.get('/api/requests/foreign?groupId=11')).statusCode,
      404,
    );
    assert.equal(
      (await f.get('/api/requests/first?groupId=22')).statusCode,
      400,
    );
    const metadata = await f.get('/api/wakes/wake-a?groupId=11');
    assert.doesNotMatch(
      metadata.body,
      /actual readable content|cursor-visible|normal business text/,
    );
  } finally {
    await f.cleanup();
  }
});

test('wake review associates failed requests and rotated sessions through stable physical turn metadata, including old schemas', async () => {
  for (const old of [false, true]) {
    const f = fixture(old);
    try {
      const before = readFileSync(f.sessionPath);
      const r = await f.get('/api/wakes/wake-a/review?groupId=11');
      assert.equal(r.statusCode, 200);
      const b = r.json();
      assert.deepEqual(b.requests.map((r: any) => r.requestId).sort(), [
        'cancel',
        'first',
      ]);
      assert.equal(b.messages.length, 3);
      assert.equal(b.tools[0].arguments.message_id, '123');
      assert.equal(b.trigger.type, 'message');
      assert.equal(
        b.requests.find((r: any) => r.requestId === 'cancel').inputTokens,
        null,
      );
      assert.deepEqual(readFileSync(f.sessionPath), before);
      if (!old) {
        assert.ok(b.events.some((e: any) => e.kind === 'model.failed'));
      }
      const h = (await f.get('/api/health')).json();
      assert.equal(h.connectivity, old ? 'unknown' : 'connected');
    } finally {
      await f.cleanup();
    }
  }
});

test('wake list and review share token triplets and include requests without assistant checkpoints', async () => {
  for (const old of [false, true]) {
    const f = fixture(old);
    try {
      const db = new DatabaseSync(f.telemetryPath);
      db.exec(
        "UPDATE model_requests SET input_tokens=50,cached_input_tokens=10,output_tokens=4 WHERE request_id='cancel'",
      );
      db.close();
      const list = (await f.get('/api/wakes?since=0&until=500')).json();
      for (const item of list.items) {
        assert.equal(item.modelRequests, 2);
        assert.equal(item.inputTokens, 150);
        assert.equal(item.uncachedInputTokens, 100);
        assert.equal(item.cachedInputTokens, 50);
        assert.equal(item.outputTokens, 14);
        const detail = (
          await f.get(`/api/wakes/${item.wakeId}/review?groupId=11`)
        ).json();
        for (const key of [
          'modelRequests',
          'inputTokens',
          'uncachedInputTokens',
          'cachedInputTokens',
          'outputTokens',
        ]) {
          assert.equal(detail.wake[key], item[key]);
        }
      }
    } finally {
      await f.cleanup();
    }
  }
  const f = fixture();
  try {
    const db = new DatabaseSync(f.telemetryPath);
    db.exec(
      `INSERT INTO model_requests VALUES('failed-only','11','new-physical-turn',440,450,10,'error','responses',80,5,NULL,'cancelled');INSERT INTO model_request_inspections(request_id,group_id,turn_id,wake_id,started_at,ended_at,status) VALUES('failed-only','11','new-physical-turn','wake-c',440,450,'error'),('running-only','11','new-physical-turn','wake-c',460,NULL,'running')`,
    );
    db.close();
    const session = new DatabaseSync(f.sessionPath);
    session.exec(
      "INSERT INTO model_session_journal VALUES(4,'session-c','wake-c','wake_begin','{}',430)",
    );
    session.close();
    const item = (await f.get('/api/wakes?since=0&until=500&limit=1')).json()
      .items[0];
    assert.equal(item.wakeId, 'wake-c');
    assert.equal(item.modelRequests, 2);
    assert.equal(item.inputTokens, 80);
    assert.equal(item.outputTokens, 5);
    assert.equal(item.cachedInputTokens, null);
    assert.equal(item.uncachedInputTokens, null);
    const review = (await f.get('/api/wakes/wake-c/review?groupId=11')).json();
    assert.equal(review.wake.modelRequests, 2);
    assert.equal(review.wake.uncachedInputTokens, null);
    assert.deepEqual(review.requests.map((r: any) => r.outcome).sort(), [
      'cancelled',
      'running',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('review preserves normalized cancellation diagnoses and old-schema nulls', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.get('/api/requests/cancel?groupId=11')).json().request
        .diagnostics,
      null,
    );
    const db = new DatabaseSync(f.telemetryPath);
    db.exec('ALTER TABLE model_requests ADD COLUMN diagnostics TEXT');
    db.prepare(
      "UPDATE model_requests SET diagnostics=? WHERE request_id='cancel'",
    ).run(
      JSON.stringify({
        abortSource: 'reset',
        failureStage: 'request',
        requestTimeoutMs: 1000,
        requestMode: 'continue_restored',
        providerParameter: 'PRIVATE_DIAGNOSTIC_PAYLOAD',
        private: 'PRIVATE_DIAGNOSTIC_PAYLOAD',
      }),
    );
    db.close();
    const response = await f.get('/api/requests/cancel?groupId=11');
    assert.deepEqual(response.json().request.diagnostics, {
      abortSource: 'reset',
      failureStage: 'request',
      requestTimeoutMs: 1000,
      requestMode: 'continue_restored',
    });
    assert.doesNotMatch(response.body, /PRIVATE_DIAGNOSTIC_PAYLOAD/);
  } finally {
    await f.cleanup();
  }
});

test('request cursor binds filters and policy; each request rechecks authorization', async () => {
  const f = fixture();
  try {
    const r = (await f.get('/api/requests?since=0&until=500&limit=1')).json();
    assert.equal(r.items[0].requestId, 'cancel');
    assert.ok(r.nextCursor);
    const next = (
      await f.get(
        `/api/requests?since=0&until=500&limit=1&cursor=${r.nextCursor}`,
      )
    ).json();
    assert.equal(next.items[0].requestId, 'first');
    assert.equal(next.nextCursor, null);
    assert.equal(
      (
        await f.get(
          `/api/requests?since=0&until=500&q=first&cursor=${r.nextCursor}`,
        )
      ).statusCode,
      400,
    );
    assert.equal((await f.get('/api/requests?limit=101')).statusCode, 400);
    assert.equal(
      (await f.get('/api/requests?since=0&until=500&outcome=cancelled')).json()
        .items.length,
      1,
    );
    f.revoke();
    assert.equal(
      (await f.get('/api/requests/first?groupId=11')).statusCode,
      400,
    );
    assert.deepEqual(
      (await f.get('/api/requests?since=0&until=500')).json().items,
      [],
    );
  } finally {
    await f.cleanup();
  }
});

test('inspection wake IDs bypass historical session association entirely', async () => {
  const f = fixture(),
    base = new Repository({
      telemetryPath: f.telemetryPath,
      groups: [{ groupId: '11', sessionPath: f.sessionPath }],
    });
  try {
    base.session = () => {
      throw new Error('unexpected historical session read');
    };
    const rows = new ReviewRepository(base).requests(
      { since: 0, until: 500 },
      '11',
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.wakeId).sort(), ['wake-a', 'wake-b']);
  } finally {
    base.close();
    await f.cleanup();
  }
});

test('large unrelated history never poisons a narrow request window or exact detail', async () => {
  const f = fixture();
  try {
    const session = new DatabaseSync(f.sessionPath);
    session.exec(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO model_session_messages SELECT 100+x,'historic-session','historic-wake',NULL,'{"role":"user","content":"unrelated history"}' FROM n`,
    );
    session.close();
    const telemetry = new DatabaseSync(f.telemetryPath);
    telemetry.exec(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO model_requests SELECT 'old-'||x,'11','old-turn',1,2,1,'success','chat',1,1,0,NULL FROM n`,
    );
    telemetry.close();
    const list = await f.get('/api/requests?since=100&until=100&groupId=11');
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 1);
    const detail = await f.get('/api/requests/first?groupId=11');
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().request.requestId, 'first');
    const wake = await f.get('/api/wakes/wake-a/review?groupId=11');
    assert.equal(wake.statusCode, 200);
    assert.equal(wake.json().requests.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('wake metadata filters apply before pagination and bind cursors', async () => {
  const f = fixture();
  try {
    const running = (
      await f.get('/api/wakes?since=0&until=500&outcome=running&limit=1')
    ).json();
    assert.equal(running.items.length, 1);
    assert.equal(running.items[0].wakeId, 'wake-b');
    const exact = (await f.get('/api/wakes?since=0&until=500&q=wake-a')).json();
    assert.equal(exact.items[0].wakeId, 'wake-a');
    const first = (await f.get('/api/wakes?since=0&until=500&limit=1')).json();
    assert.equal(
      (
        await f.get(
          `/api/wakes?since=0&until=500&q=wake&cursor=${first.nextCursor}`,
        )
      ).statusCode,
      400,
    );
  } finally {
    await f.cleanup();
  }
});

test('runtime events expose skipped triggers, isolate groups, bind keyset cursors and infer heartbeat health honestly', async () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.telemetryPath);
    const insert = db.prepare(
      'INSERT INTO runtime_events VALUES(?,?,?,?,?,?,?)',
    );
    insert.run(
      4,
      400,
      'trigger.skipped',
      '11',
      'physical-turn',
      'message-visible',
      JSON.stringify({
        reason: 'attention_budget',
        level: 'debug',
        cursor: 'visible',
        password: 'hide-me',
      }),
    );
    insert.run(
      5,
      410,
      'trigger.accepted',
      '22',
      'physical-turn',
      'foreign-message',
      '{}',
    );
    insert.run(
      6,
      420,
      'tool.finished',
      null,
      'physical-turn',
      'unscoped',
      '{}',
    );
    db.close();
    const response = await f.get(
      '/api/events?since=0&until=500&groupId=11&category=trigger',
    );
    assert.equal(response.statusCode, 200);
    const b = response.json();
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0].event, 'trigger.skipped');
    assert.equal(b.items[0].title, '未触发唤醒');
    assert.equal(eventTitle('unknown.future'), '其他事件');
    assert.equal(eventTitle('model.future'), '模型事件');
    assert.equal(b.items[0].detail.reason, 'attention_budget');
    assert.equal(b.items[0].level, 'debug');
    assert.doesNotMatch(response.body, /hide-me|foreign-message/);
    const first = (await f.get('/api/events?since=0&until=500&limit=1')).json();
    assert.equal(first.items[0].sequence, 4);
    assert.ok(first.nextCursor);
    const next = (
      await f.get(
        `/api/events?since=0&until=500&limit=1&cursor=${first.nextCursor}`,
      )
    ).json();
    assert.equal(next.items[0].sequence, 3);
    assert.equal(
      (
        await f.get(
          `/api/events?since=0&until=500&q=trigger&cursor=${first.nextCursor}`,
        )
      ).statusCode,
      400,
    );
    assert.equal((await f.get('/api/events?category=unsafe')).statusCode, 400);
    assert.equal(
      (await f.get('/api/events?since=0&until=500&q=attention_budget')).json()
        .items.length,
      0,
    );
    const update = new DatabaseSync(f.telemetryPath);
    update.exec(
      `UPDATE runtime_events SET fields='{"status":"disconnected"}' WHERE event='app.heartbeat';INSERT INTO runtime_events VALUES(7,450,'onebot.message_received','11',NULL,'received-message','{}')`,
    );
    update.close();
    const health = (await f.get('/api/health')).json();
    assert.equal(health.connectivity, 'disconnected');
    assert.equal(health.groups[0].lastObservedMessageAt, 450);
    assert.equal(health.groups[0].observationSource, 'runtime_received');
  } finally {
    await f.cleanup();
  }
});

test('event timeline omits heartbeat noise but keeps finite global failure diagnostics', async () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.telemetryPath),
      insert = db.prepare('INSERT INTO runtime_events VALUES(?,?,?,?,?,?,?)');
    const events = [
      'app.start',
      'app.startup_failed',
      'app.diagnostics_unavailable',
      'onebot.connection_failed',
      'onebot.reconnect_scheduled',
      'onebot.heartbeat_timeout',
    ];
    events.forEach((event, i) =>
      insert.run(10 + i, 400 + i, event, null, null, null, '{}'),
    );
    insert.run(20, 420, 'app.future_unreviewed', null, null, null, '{}');
    insert.run(21, 421, 'onebot.connection_failed', '22', null, null, '{}');
    for (let i = 0; i < 100; i++) {
      insert.run(
        100 + i,
        499,
        'app.heartbeat',
        null,
        null,
        null,
        '{"status":"connected"}',
      );
    }
    db.close();
    const all = (
      await f.get('/api/events?since=0&until=500&groupId=11&limit=100')
    ).json();
    assert.equal(all.nextCursor, null);
    assert.ok(
      all.items.every(
        (item: any) =>
          item.event !== 'app.heartbeat' &&
          item.groupId !== '22' &&
          item.event !== 'app.future_unreviewed',
      ),
    );
    for (const event of events) {
      const item = all.items.find((item: any) => item.event === event);
      assert.ok(item, event);
      assert.notEqual(item.title, event);
      assert.match(item.title, /[\u4e00-\u9fff]/);
    }
    const page = (
      await f.get('/api/events?since=0&until=500&groupId=11&limit=2')
    ).json();
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].event, 'onebot.heartbeat_timeout');
    assert.ok(page.nextCursor);
    assert.equal((await f.get('/api/health')).json().lastHeartbeatAt, 499);
  } finally {
    await f.cleanup();
  }
});

test('aggregate content budget, exact assistant tool scope, and real optional message timestamps', async () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.sessionPath);
    db.exec('ALTER TABLE model_session_messages ADD COLUMN created_at INTEGER');
    db.exec('UPDATE model_session_messages SET created_at=99 WHERE seq=1');
    const insert = db.prepare(
      'INSERT INTO model_session_messages VALUES(?,?,?,?,?,?)',
    );
    for (let i = 0; i < 70; i++) {
      insert.run(
        100 + i,
        'session-a',
        'wake-a',
        null,
        JSON.stringify({ role: 'user', content: 'x'.repeat(160000) }),
        100 + i,
      );
    }
    const tool = db.prepare(
      'INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (let i = 0; i < 15; i++) {
      tool.run(
        i + 2,
        'read_messages',
        'wake-a',
        'finished',
        '{}',
        JSON.stringify({ status: 'ok', text: 'y'.repeat(200000) }),
        110,
        120,
        130,
        999,
        'unrelated-' + i,
      );
    }
    db.close();
    const exact = await f.get('/api/requests/first?groupId=11');
    assert.equal(exact.statusCode, 200);
    assert.equal(exact.json().tools.length, 1);
    assert.ok(exact.body.length < 10000);
    assert.ok(!exact.json().requestBody.source);
    const wake = await f.get('/api/wakes/wake-a/review?groupId=11');
    assert.equal(wake.statusCode, 200);
    assert.equal(wake.json().contentTruncated, true);
    assert.ok(Buffer.byteLength(wake.body) < 9 * 1024 * 1024);
    assert.equal(wake.json().messages[0].createdAt, 99);
    assert.equal(wake.json().events[0]?.title, '唤醒开始');
  } finally {
    await f.cleanup();
  }
  const old = fixture(true);
  try {
    const detail = (await old.get('/api/requests/first?groupId=11')).json();
    assert.equal(detail.requestBody.source, 'persisted_session_context');
    assert.equal(detail.responseBody.role, 'assistant');
  } finally {
    await old.cleanup();
  }
});

test('long content is explicitly bounded, empty errors stay null, and running inspection-only requests remain visible', async () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.telemetryPath);
    db.prepare(
      "UPDATE model_request_inspections SET request_json=?,error_text='' WHERE request_id='first'",
    ).run(JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }));
    db.exec(
      "INSERT INTO model_request_inspections(request_id,group_id,turn_id,wake_id,started_at,transport,model,status) VALUES('running','11','physical-turn','wake-b',450,'responses','test','running')",
    );
    db.close();
    const r = (await f.get('/api/requests/first?groupId=11')).json();
    assert.equal(r.contentTruncated, true);
    assert.equal(r.errorText, null);
    const running = (await f.get('/api/requests/running?groupId=11')).json();
    assert.equal(running.request.status, 'running');
    assert.equal(running.request.outcome, 'running');
    assert.equal(
      (await f.get('/api/requests?since=0&until=500&outcome=running')).json()
        .items.length,
      1,
    );
    assert.equal(running.request.endedAt, null);
    assert.equal(running.request.tps, null);
  } finally {
    await f.cleanup();
  }
});

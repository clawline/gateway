#!/usr/bin/env node
/**
 * REL-* reliability suite.
 *
 * Verifies the physical truth: every message either appears at the receiver
 * or returns an explicit error — no silent failure, no ghosts.
 *
 * Run: node test/rel-suite.js  (assumes test-gateway @ 19181 + mock-backend running)
 *
 * Exit code: 0 on all-pass (or all-pass-with-skips), 1 on any failure.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const GW = process.env.REL_GATEWAY_URL || 'http://localhost:19181';
const CHANNEL_ID = process.env.REL_CHANNEL_ID || 'e2e-rel';
const USER_TOKEN = process.env.REL_USER_TOKEN || 'reltoken-1234567890abcdef';

// Supabase direct read for ground-truth verification
const SUPA_URL = process.env.REL_SUPA_URL || 'https://db.dora.restry.cn';
const SUPA_KEY = process.env.REL_SUPA_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q';

const results = [];

function record(id, status, detail) {
  results.push({ id, status, detail });
  const tag = status === 'PASS' ? '✓' : status === 'SKIP' ? '↷' : '✗';
  console.log(`${tag} ${id} ${status}: ${detail}`);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function dbCount(channelId, messageId, direction) {
  const res = await fetch(
    `${SUPA_URL}/pg/rest/v1/cl_messages?channel_id=eq.${channelId}&message_id=eq.${encodeURIComponent(messageId)}` +
      (direction ? `&direction=eq.${direction}` : '') + '&select=id',
    { headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } }
  );
  if (!res.ok) return -1;
  const rows = await res.json();
  return Array.isArray(rows) ? rows.length : -1;
}

async function dbCleanup(channelId) {
  // Wipe all rows for a channel — safe because e2e-rel is dedicated to tests.
  await fetch(
    `${SUPA_URL}/pg/rest/v1/cl_messages?channel_id=eq.${channelId}`,
    { method: 'DELETE', headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } }
  );
  await fetch(
    `${SUPA_URL}/pg/rest/v1/cl_threads?channel_id=eq.${channelId}`,
    { method: 'DELETE', headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } }
  );
}

async function apiChat(message, opts = {}) {
  const body = JSON.stringify({
    message,
    channelId: CHANNEL_ID,
    agentId: opts.agentId || 'main',
    senderId: opts.senderId || 'rel-user',
    chatId: opts.chatId || `rel-${Date.now()}`,
    ...(opts.timeout != null ? { timeout: opts.timeout } : {}),
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
  });
  return fetchJson(`${GW}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${USER_TOKEN}`,
    },
    body,
  });
}

// SSE client. Returns { events, status, abort, done }.
// `events` is appended to as frames arrive. `done` resolves on stream end.
async function apiChatSSE(message, opts = {}) {
  const ac = new AbortController();
  const events = [];
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

  const body = JSON.stringify({
    message,
    channelId: CHANNEL_ID,
    agentId: opts.agentId || 'main',
    senderId: opts.senderId || 'rel-user',
    chatId: opts.chatId || `rel-${Date.now()}`,
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
  });

  const res = await fetch(`${GW}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${USER_TOKEN}`,
    },
    body,
    signal: ac.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    rejectDone(new Error(`SSE handshake failed: ${res.status} ${text}`));
    return { status: res.status, events, abort: () => ac.abort(), done };
  }

  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        // Split on SSE record boundary (blank line)
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const record = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!record.trim() || record.startsWith(':')) continue; // ignore comments / heartbeats
          let evt = 'message';
          let dataLines = [];
          for (const line of record.split('\n')) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          let data = null;
          if (dataLines.length) {
            try { data = JSON.parse(dataLines.join('\n')); } catch { data = dataLines.join('\n'); }
          }
          events.push({ event: evt, data });
          if (evt === 'done' || evt === 'error') {
            // Allow the loop to drain naturally
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') rejectDone(e);
    }
    resolveDone(events);
  })();

  return { status: res.status, events, abort: () => ac.abort(), done };
}

// ---------- REL-01 ----------
async function rel01() {
  await dbCleanup(CHANNEL_ID);
  const r = await apiChat('REL-01 ping', { chatId: 'rel-01' });
  // Expect: HTTP 200 + 2 DB rows  OR  4xx/5xx + 0 DB rows
  if (r.status === 200 && r.body?.ok) {
    const inboundMid = r.body.inboundMessageId;
    const replyMid = r.body.messageId;
    if (!inboundMid || !replyMid) {
      return record('REL-01', 'FAIL', `200 but missing ids: ${JSON.stringify(r.body)}`);
    }
    const inboundCount = await dbCount(CHANNEL_ID, inboundMid, 'inbound');
    const outboundCount = await dbCount(CHANNEL_ID, replyMid, 'outbound');
    if (inboundCount === 1 && outboundCount === 1) {
      return record('REL-01', 'PASS', `ack + DB { inbound: 1, outbound: 1 }`);
    }
    return record('REL-01', 'FAIL', `ack but DB { inbound:${inboundCount}, outbound:${outboundCount} } — want 1/1`);
  }
  // Error path
  return record('REL-01', 'FAIL', `unexpected: status=${r.status} body=${JSON.stringify(r.body)}`);
}

// ---------- REL-02 ----------
async function rel02() {
  await dbCleanup(CHANNEL_ID);
  const N = Number(process.env.REL_PARALLEL || '20'); // default 20 to keep CI fast; raise locally
  const startTs = Date.now();
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      apiChat(`REL-02 ${i}`, { chatId: `rel-02-${i % 5}`, timeout: 30000 })
        .catch((e) => ({ status: 0, body: { ok: false, error: String(e) } }))
    )
  );
  let ack = 0, err = 0;
  const ackInboundIds = [];
  for (const r of results) {
    if (r.status === 200 && r.body?.ok) {
      ack++;
      if (r.body.inboundMessageId) ackInboundIds.push(r.body.inboundMessageId);
    } else {
      err++;
    }
  }
  // Wait briefly for any in-flight persists to settle
  await sleep(2000);

  // Ghost check (post-D6-fix): inbound persistence is unconditional once
  // the request is accepted. So total inbound rows in the channel must equal
  // (ack + err) — every accepted request leaves a row, no row exists without
  // a corresponding response.
  let ghosts = 0, missing = 0;
  for (const id of ackInboundIds) {
    const c = await dbCount(CHANNEL_ID, id, 'inbound');
    if (c !== 1) missing++;
  }
  const totalRowsRes = await fetch(
    `${SUPA_URL}/pg/rest/v1/cl_messages?channel_id=eq.${CHANNEL_ID}&direction=eq.inbound&select=id`,
    { headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } }
  );
  const totalRows = (await totalRowsRes.json()).length;
  // Every request that reached the gateway and passed validation persists
  // inbound, even if it later errors. So expected total = N (= ack + err).
  ghosts = Math.max(0, totalRows - (ack + err));

  const ok = (ack + err === N) && missing === 0 && ghosts === 0;
  const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
  if (ok) {
    record('REL-02', 'PASS',
      `${N} parallel, ack=${ack} err=${err} missing=${missing} ghost-rows=${ghosts} elapsed=${elapsed}s`);
  } else {
    record('REL-02', 'FAIL',
      `${N} parallel, ack=${ack} err=${err} missing=${missing} ghost-rows=${ghosts} totalRows=${totalRows}`);
  }
}

// ---------- REL-03 ----------
async function rel03() {
  await dbCleanup(CHANNEL_ID);
  // Send 5 messages, all should ack
  const before = [];
  for (let i = 0; i < 5; i++) {
    const r = await apiChat(`REL-03 before-${i}`, { chatId: 'rel-03', timeout: 30000 });
    if (r.status !== 200 || !r.body?.ok) {
      return record('REL-03', 'FAIL', `setup msg ${i} failed: ${r.status}`);
    }
    before.push(r.body.inboundMessageId);
  }

  // Kill mock-backend
  const { execSync } = await import('node:child_process');
  try {
    execSync('pkill -f "test/mock-backend.js"', { stdio: 'ignore' });
  } catch {}
  // Wait for backend to drop
  await sleep(2000);

  // Send 3 more — should fail (backend disconnected)
  const after = [];
  for (let i = 0; i < 3; i++) {
    const r = await apiChat(`REL-03 after-${i}`, { chatId: 'rel-03', timeout: 5000 });
    after.push({ status: r.status, ok: r.body?.ok });
  }
  const allFailed = after.every((r) => r.status >= 400 || !r.ok);

  // Restart mock-backend (detached so it survives this script)
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const out = fs.openSync('/tmp/clawline-mock-backend.log', 'a');
  const mock = spawn('node', ['test/mock-backend.js'], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env },
  });
  mock.unref();
  fs.closeSync(out);
  rel03._respawnedPid = mock.pid;
  await sleep(3000); // wait for handshake

  // All 5 'before' messages should still be in DB (already persisted)
  let preserved = 0;
  for (const id of before) {
    const c = await dbCount(CHANNEL_ID, id, 'inbound');
    if (c === 1) preserved++;
  }

  if (preserved === 5 && allFailed) {
    record('REL-03', 'PASS', `5 pre-kill messages preserved, 3 post-kill all rejected, mock-backend respawned (PID ${mock.pid})`);
  } else {
    record('REL-03', 'FAIL', `preserved=${preserved}/5, all-3-failed=${allFailed} after=${JSON.stringify(after)}`);
  }
}

// ---------- REL-04 ----------
async function rel04() {
  record('REL-04', 'SKIP', 'pending ADD-BACK #6 (lastSeenMessageId resync on reconnect)');
}

// ---------- REL-05 ----------
async function rel05() {
  record('REL-05', 'SKIP', 'pending ADD-BACK #7 (HTTP idempotency check)');
}

// ---------- REL-06: inbound persists independently of outbound ----------
// Iron rule: a user's inbound message MUST land in cl_messages regardless of
// whether the agent replied, errored, or silently dropped it. Without this,
// crashed/timed-out conversations leave no audit trail and no resyncable history.
//
// Currently FAILS by design (D6 ack-then-persist). Guardrail-first per resley.

async function rel06Once(subId, chatIdSubstr, opts) {
  await dbCleanup(CHANNEL_ID);
  const messageId = `rel-06-${subId}-${Date.now()}`;
  const r = await apiChat(`REL-06 ${subId}`, {
    chatId: `rel-06-${chatIdSubstr}-${subId}`,
    messageId,
    timeout: 5000, // min allowed by server
  }).catch((e) => ({ status: 0, body: { ok: false, error: String(e) } }));

  // Allow any in-flight async persistence to settle
  await sleep(1500);

  const inboundCount = await dbCount(CHANNEL_ID, messageId, 'inbound');
  // Total outbound rows in channel (we don't know reply messageId)
  const outRes = await fetch(
    `${SUPA_URL}/pg/rest/v1/cl_messages?channel_id=eq.${CHANNEL_ID}&direction=eq.outbound&select=id`,
    { headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } }
  );
  const outboundCount = (await outRes.json()).length;

  const httpOk = opts.expectStatuses.includes(r.status);
  const detail = `inbound=${inboundCount} outbound=${outboundCount} HTTP=${r.status} (want HTTP in [${opts.expectStatuses.join(',')}], inbound==1)`;

  if (httpOk && inboundCount === 1) {
    record(`REL-06${subId}`, 'PASS', detail);
  } else {
    record(`REL-06${subId}`, 'FAIL', detail);
  }
}

async function rel06a() {
  // agent timeout — mock stays silent
  await rel06Once('a', 'timeout', { expectStatuses: [504] });
}

async function rel06b() {
  // agent reject — mock sends relay.server.reject
  await rel06Once('b', 'reject', { expectStatuses: [502, 200] });
}

async function rel06c() {
  // agent silently drops — mock stays silent (same observable as 06a, kept distinct per spec)
  await rel06Once('c', 'drop', { expectStatuses: [504] });
}

// ---------- REL-07: SSE streaming ----------
// SSE replaces the synchronous HTTP path's 600s hard cap with an event-driven
// stream. Verify: (a) accepted+delta+done sequence; (b) long task with many
// deltas finishes without server-side timeout; (c) agent error → SSE error
// event AND inbound row still in DB; (d) caller disconnect doesn't crash GW.

async function rel07a() {
  await dbCleanup(CHANNEL_ID);
  const messageId = `rel-07a-${Date.now()}`;
  const stream = await apiChatSSE('REL-07a', {
    chatId: `rel-07-stream-a-${Date.now()}`,
    messageId,
  });
  if (stream.status !== 200) {
    return record('REL-07a', 'FAIL', `SSE handshake status=${stream.status}`);
  }
  await stream.done;
  const names = stream.events.map((e) => e.event);
  const accepted = stream.events.find((e) => e.event === 'accepted');
  const deltas = stream.events.filter((e) => e.event === 'delta');
  const done = stream.events.find((e) => e.event === 'done');
  if (
    accepted?.data?.inboundMessageId === messageId &&
    deltas.length >= 1 &&
    done?.data?.replyMessageId
  ) {
    record('REL-07a', 'PASS', `events=[${names.join(',')}] deltas=${deltas.length}`);
  } else {
    record('REL-07a', 'FAIL', `unexpected sequence: ${JSON.stringify(names)} accepted=${!!accepted} deltas=${deltas.length} done=${!!done}`);
  }
}

async function rel07b() {
  await dbCleanup(CHANNEL_ID);
  const messageId = `rel-07b-${Date.now()}`;
  const startMs = Date.now();
  const stream = await apiChatSSE('REL-07b long', {
    chatId: `rel-07-long-b-${Date.now()}`,
    messageId,
  });
  if (stream.status !== 200) {
    return record('REL-07b', 'FAIL', `SSE handshake status=${stream.status}`);
  }
  await stream.done;
  const elapsed = Date.now() - startMs;
  const deltas = stream.events.filter((e) => e.event === 'delta');
  const done = stream.events.find((e) => e.event === 'done');
  if (deltas.length >= 10 && done && elapsed >= 10_000) {
    record('REL-07b', 'PASS', `${deltas.length} deltas over ${(elapsed / 1000).toFixed(1)}s, no server-side cap`);
  } else {
    record('REL-07b', 'FAIL', `deltas=${deltas.length} done=${!!done} elapsed=${elapsed}ms`);
  }
}

async function rel07c() {
  await dbCleanup(CHANNEL_ID);
  const messageId = `rel-07c-${Date.now()}`;
  // Reuse rel-06-reject mock-backend mode — agent sends relay.server.reject.
  const stream = await apiChatSSE('REL-07c', {
    chatId: `rel-06-reject-07c-${Date.now()}`,
    messageId,
  });
  if (stream.status !== 200) {
    return record('REL-07c', 'FAIL', `SSE handshake status=${stream.status}`);
  }
  await stream.done;
  const errEvt = stream.events.find((e) => e.event === 'error');
  await sleep(800);
  const inboundCount = await dbCount(CHANNEL_ID, messageId, 'inbound');
  if (errEvt && inboundCount === 1) {
    record('REL-07c', 'PASS', `error event delivered + inbound persisted (REL-06 invariant holds for SSE)`);
  } else {
    record('REL-07c', 'FAIL', `errEvt=${!!errEvt} inboundCount=${inboundCount}`);
  }
}

async function rel07d() {
  await dbCleanup(CHANNEL_ID);
  // Start a long stream then abort early. Verify (1) gateway doesn't crash,
  // (2) a follow-up sync request still succeeds.
  const stream = await apiChatSSE('REL-07d disconnect', {
    chatId: `rel-07-long-d-${Date.now()}`,
    messageId: `rel-07d-${Date.now()}`,
  });
  if (stream.status !== 200) {
    return record('REL-07d', 'FAIL', `SSE handshake status=${stream.status}`);
  }
  // Wait for at least one delta so we know the pipe is hot, then abort.
  for (let i = 0; i < 30 && stream.events.filter((e) => e.event === 'delta').length === 0; i++) {
    await sleep(100);
  }
  stream.abort();
  await sleep(500);
  // Follow-up sync request must still work.
  const r = await apiChat('REL-07d follow-up', { chatId: `rel-07d-followup-${Date.now()}`, timeout: 10_000 });
  if (r.status === 200 && r.body?.ok) {
    record('REL-07d', 'PASS', `caller abort handled cleanly, follow-up sync request OK`);
  } else {
    record('REL-07d', 'FAIL', `follow-up failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

// ---------- main ----------
async function preflight() {
  // Check gateway alive
  try {
    const r = await fetch(`${GW}/healthz`);
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (e) {
    console.error(`✗ gateway not reachable at ${GW}: ${e.message}`);
    process.exit(2);
  }
  // Check mock-backend connected (backendCount on e2e-rel)
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${GW}/healthz`);
    const j = await r.json();
    const ch = (j.channels || []).find((c) => c.channelId === CHANNEL_ID);
    if (ch?.backendConnected) return;
    await sleep(1000);
  }
  console.error(`✗ mock-backend did not register on channel ${CHANNEL_ID} within 30s`);
  process.exit(2);
}

async function main() {
  console.log(`REL suite — gateway=${GW}, channel=${CHANNEL_ID}`);
  await preflight();
  console.log('');

  await rel01();
  await rel02();
  await rel03();
  await rel04();
  await rel05();
  await rel06a();
  await rel06b();
  await rel06c();
  await rel07a();
  await rel07b();
  await rel07c();
  await rel07d();

  console.log('\n═══ SUMMARY ═══');
  for (const r of results) {
    const tag = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '↷' : '✗';
    console.log(`${tag} ${r.id.padEnd(8)} ${r.status.padEnd(5)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(2);
});

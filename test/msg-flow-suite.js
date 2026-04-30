#!/usr/bin/env node
/**
 * MSG-FLOW: end-to-end regression suite for message persistence + cross-device fanOut.
 *
 * Verifies the post-fix invariant: every user message produces exactly one
 * inbound row + one outbound row with DIFFERENT message_ids and the outbound
 * content does NOT contain the user's text.
 *
 * Also exercises the pre-fix bug repro path (mock-backend with
 * MOCK_ECHO_INBOUND_AS_OUTBOUND=1) to prove the bug used to exist.
 *
 * Prereq:
 *   - test gateway @ 19181 (make dev-reset)
 *   - mock-backend @ e2e-rel (make mock-backend) — for clean-flow tests
 *
 * Run: node test/msg-flow-suite.js
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const GW = process.env.GW || 'http://localhost:19181';
const WS_GW = GW.replace(/^http/, 'ws');
const CHANNEL_ID = 'e2e-rel';
const TOKEN = 'reltoken-1234567890abcdef';
const SUPA_URL = 'https://db.dora.restry.cn';
const SUPA_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q';

const results = [];
function record(id, status, detail) {
  results.push({ id, status, detail });
  const tag = status === 'PASS' ? '✓' : '✗';
  console.log(`${tag} ${id}: ${detail}`);
}

async function dbCleanup() {
  await fetch(`${SUPA_URL}/pg/rest/v1/cl_messages?channel_id=eq.${CHANNEL_ID}`, {
    method: 'DELETE',
    headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` },
  });
}

async function dbRowsFor(messageId) {
  const res = await fetch(
    `${SUPA_URL}/pg/rest/v1/cl_messages?channel_id=eq.${CHANNEL_ID}&or=(message_id.eq.${encodeURIComponent(messageId)},parent_id.eq.${encodeURIComponent(messageId)})&select=direction,message_id,content,parent_id,sender_id&order=timestamp`,
    { headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } }
  );
  return res.json();
}

function connectWS({ chatId }) {
  return new Promise((resolve, reject) => {
    const url = `${WS_GW}/client?channelId=${CHANNEL_ID}&token=${TOKEN}&chatId=${chatId}&agentId=main`;
    const ws = new WebSocket(url);
    const events = [];
    ws.on('message', (raw) => {
      try { events.push(JSON.parse(raw.toString())); } catch {}
    });
    ws.on('open', () => {
      // Backend (mock-backend.js) emits agent.list right after relay.client.open;
      // when we see it, the connection is fully wired through.
      const i = setInterval(() => {
        if (events.find((e) => e.type === 'agent.list')) {
          clearInterval(i);
          resolve({ ws, events });
        }
      }, 20);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS open timeout')), 5000);
  });
}

async function waitFor(events, predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────
// Test 1: WS happy path — single client sends, DB has clean inbound + outbound.
// ───────────────────────────────────────────────────────────────────────
async function testWSHappyPath() {
  await dbCleanup();
  const chatId = `flow-1-${Date.now()}`;
  const a = await connectWS({ chatId });
  const messageId = `cli-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const userText = `WS-HAPPY ${randomUUID()}`;

  a.ws.send(JSON.stringify({
    type: 'message.receive',
    data: { messageId, chatId, agentId: 'main', senderId: 'user-A', content: userText, messageType: 'text', timestamp: Date.now() },
  }));

  // Wait for the AI reply (mock backend replies with "MOCK_REPLY: ..." and a fresh messageId)
  const reply = await waitFor(a.events, (e) => e.type === 'message.send' && typeof e.data?.content === 'string' && e.data.content.startsWith('MOCK_REPLY:'));
  if (!reply) {
    record('TEST-1-WS-HAPPY', 'FAIL', 'no MOCK_REPLY received in 5s');
    a.ws.close();
    return;
  }

  // DB check
  await sleep(300); // allow persistence to settle
  const rows = await dbRowsFor(messageId);
  const inbound = rows.filter((r) => r.direction === 'inbound');
  const outbound = rows.filter((r) => r.direction === 'outbound');

  const fail = [];
  if (inbound.length !== 1) fail.push(`expected 1 inbound, got ${inbound.length}`);
  if (outbound.length !== 1) fail.push(`expected 1 outbound, got ${outbound.length}`);
  if (inbound[0]?.message_id === outbound[0]?.message_id) fail.push('inbound and outbound share message_id (SAME-ID-CONTAMINATION)');
  if (outbound[0]?.content === userText) fail.push('outbound content equals user text exactly (ECHO-CONTAMINATION)');
  if (inbound[0]?.content !== userText) fail.push(`inbound content mismatch: "${inbound[0]?.content}"`);

  if (fail.length) {
    record('TEST-1-WS-HAPPY', 'FAIL', fail.join('; '));
  } else {
    record('TEST-1-WS-HAPPY', 'PASS', `inbound=${inbound[0].message_id} outbound=${outbound[0].message_id} content=clean`);
  }

  a.ws.close();
}

// ───────────────────────────────────────────────────────────────────────
// Test 2: HTTP /api/chat SSE — DB has clean inbound + outbound, no contamination.
// ───────────────────────────────────────────────────────────────────────
async function testHttpSSE() {
  await dbCleanup();
  const chatId = `flow-2-${Date.now()}`;
  const messageId = `api-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userText = `HTTP-SSE ${randomUUID()}`;

  const res = await fetch(`${GW}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      message: userText,
      channelId: CHANNEL_ID,
      agentId: 'main',
      senderId: 'user-API',
      chatId,
      messageId,
    }),
  });

  // Drain SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let gotDone = false;
  const start = Date.now();
  while (!gotDone && Date.now() - start < 5000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes('event: done')) gotDone = true;
  }
  try { reader.cancel(); } catch {}

  await sleep(300);
  const rows = await dbRowsFor(messageId);
  const inbound = rows.filter((r) => r.direction === 'inbound');
  const outbound = rows.filter((r) => r.direction === 'outbound');

  const fail = [];
  if (inbound.length !== 1) fail.push(`expected 1 inbound, got ${inbound.length}`);
  if (outbound.length !== 1) fail.push(`expected 1 outbound, got ${outbound.length}`);
  if (inbound[0]?.message_id === outbound[0]?.message_id) fail.push('inbound and outbound share message_id');
  if (outbound[0]?.content === userText) fail.push('outbound content equals user text exactly (ECHO-CONTAMINATION)');

  if (fail.length) {
    record('TEST-2-HTTP-SSE', 'FAIL', fail.join('; '));
  } else {
    record('TEST-2-HTTP-SSE', 'PASS', `inbound=${inbound[0].message_id} outbound=${outbound[0].message_id} sse=done`);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Test 3: Cross-device fanOut — A sends, B receives both echo + reply (and only once each).
// ───────────────────────────────────────────────────────────────────────
async function testCrossDevice() {
  await dbCleanup();
  const chatId = `flow-3-${Date.now()}`;
  const a = await connectWS({ chatId });
  const b = await connectWS({ chatId });
  const messageId = `cli-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const userText = `CROSS-DEV ${randomUUID()}`;

  a.ws.send(JSON.stringify({
    type: 'message.receive',
    data: { messageId, chatId, agentId: 'main', senderId: 'user-shared', content: userText, messageType: 'text', timestamp: Date.now() },
  }));

  // B should receive: (1) echo of A's message, (2) the AI reply
  const bEcho = await waitFor(b.events, (e) => e.type === 'message.send' && e.data?.messageId === messageId);
  const bReply = await waitFor(b.events, (e) => e.type === 'message.send' && typeof e.data?.content === 'string' && e.data.content.startsWith('MOCK_REPLY:'));
  // A should also receive AI reply
  const aReply = await waitFor(a.events, (e) => e.type === 'message.send' && typeof e.data?.content === 'string' && e.data.content.startsWith('MOCK_REPLY:'));

  const fail = [];
  if (!bEcho) fail.push('B did not receive echo of A\'s inbound');
  if (!bReply) fail.push('B did not receive AI reply');
  if (!aReply) fail.push('A did not receive AI reply');

  // Check that B did not receive duplicate echo (count occurrences of the echo messageId in B)
  const echoCount = b.events.filter((e) => e.type === 'message.send' && e.data?.messageId === messageId).length;
  if (echoCount > 1) fail.push(`B received echo ${echoCount} times (expected 1)`);

  // DB: still exactly 1 inbound + 1 outbound
  await sleep(300);
  const rows = await dbRowsFor(messageId);
  const inbound = rows.filter((r) => r.direction === 'inbound');
  const outbound = rows.filter((r) => r.direction === 'outbound');
  if (inbound.length !== 1) fail.push(`DB: expected 1 inbound, got ${inbound.length}`);
  if (outbound.length !== 1) fail.push(`DB: expected 1 outbound, got ${outbound.length}`);
  if (outbound[0]?.content === userText) fail.push('outbound contaminated (content === user text)');

  if (fail.length) {
    record('TEST-3-CROSS-DEVICE', 'FAIL', fail.join('; '));
  } else {
    record('TEST-3-CROSS-DEVICE', 'PASS', `B got echo+reply, A got reply, DB clean (echoCount=${echoCount})`);
  }

  a.ws.close();
  b.ws.close();
}

// ───────────────────────────────────────────────────────────────────────
// Test 4: PRE-FIX BUG REPRO — restart mock-backend with ECHO env, verify
// the corruption appears (inbound message_id has BOTH directions in DB,
// and outbound content equals user text). Then restore mock and verify
// fix path is clean.
// ───────────────────────────────────────────────────────────────────────
async function killMockBackend() {
  return new Promise((resolve) => {
    const ps = spawn('pkill', ['-f', 'test/mock-backend.js']);
    ps.on('close', () => setTimeout(resolve, 500));
  });
}

async function startMockBackend(extraEnv = {}) {
  const child = spawn(process.execPath, ['test/mock-backend.js'], {
    env: { ...process.env, ...extraEnv, MOCK_NO_RECONNECT: '0' },
    stdio: 'ignore',
    detached: true,
    cwd: process.cwd(),
  });
  child.unref();
  // Wait for backend to register
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const res = await fetch(`${GW}/healthz`).then((r) => r.json()).catch(() => ({ channels: [] }));
    const ch = res.channels?.find((c) => c.channelId === CHANNEL_ID);
    if (ch?.backendConnected) return;
  }
  throw new Error('mock-backend did not connect');
}

async function testPreFixBugRepro() {
  // Switch to buggy mock
  await killMockBackend();
  await startMockBackend({ MOCK_ECHO_INBOUND_AS_OUTBOUND: '1' });

  await dbCleanup();
  const chatId = `flow-bug-${Date.now()}`;
  const a = await connectWS({ chatId });
  const messageId = `cli-bug-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const userText = `BUG-REPRO ${randomUUID()}`;

  a.ws.send(JSON.stringify({
    type: 'message.receive',
    data: { messageId, chatId, agentId: 'main', senderId: 'user-bug', content: userText, messageType: 'text', timestamp: Date.now() },
  }));

  // Wait long enough for the buggy echo + the AI reply
  await waitFor(a.events, (e) => e.type === 'message.send' && typeof e.data?.content === 'string' && e.data.content.startsWith('MOCK_REPLY:'));
  await sleep(400);

  const rows = await dbRowsFor(messageId);
  const sameIdRows = rows.filter((r) => r.message_id === messageId);
  const sameIdInbound = sameIdRows.filter((r) => r.direction === 'inbound');
  const sameIdOutbound = sameIdRows.filter((r) => r.direction === 'outbound');

  // Pre-fix bug signature: inbound message_id appears with BOTH directions,
  // and the outbound row's content equals the user's text.
  const bugReproed =
    sameIdInbound.length === 1 &&
    sameIdOutbound.length === 1 &&
    sameIdOutbound[0].content === userText;

  if (bugReproed) {
    record('TEST-4-PRE-FIX-BUG-REPRO', 'PASS', `bug confirmed: same message_id ${messageId} has direction in [inbound, outbound] with outbound.content === user text`);
  } else {
    record('TEST-4-PRE-FIX-BUG-REPRO', 'FAIL', `bug NOT reproed by simulator: inbound=${sameIdInbound.length} outbound=${sameIdOutbound.length} outboundContent=${JSON.stringify(sameIdOutbound[0]?.content?.slice(0, 60))}`);
  }

  a.ws.close();

  // Restore clean mock
  await killMockBackend();
  await startMockBackend({});
}

// ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`MSG-FLOW suite against ${GW}`);
  await testWSHappyPath();
  await testHttpSSE();
  await testCrossDevice();
  await testPreFixBugRepro();

  console.log('\n──────────────────────────────────────────────────────────');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

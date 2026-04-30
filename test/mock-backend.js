#!/usr/bin/env node
/**
 * Mock backend for REL-* reliability tests.
 *
 * Speaks the relay.backend.* protocol. Auto-replies to message.receive
 * with a deterministic message.send (so tests don't depend on OpenClaw
 * or any LLM being online).
 *
 * Tunables (env):
 *   MOCK_RELAY_URL          ws://localhost:19181/backend
 *   MOCK_CHANNEL_ID         e2e-rel
 *   MOCK_SECRET             rel-secret
 *   MOCK_REPLY_DELAY_MS     50           — simulate slow agents (raise to test timeouts)
 *   MOCK_DROP_REPLY_TO      0|1          — strip replyTo from message.send (D3 verification)
 *   MOCK_NEVER_REPLY        0|1          — never send message.send (REL-01 timeout path)
 *   MOCK_INSTANCE_ID        mock-backend
 */
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const RELAY_URL = process.env.MOCK_RELAY_URL || 'ws://localhost:19181/backend';
const CHANNEL_ID = process.env.MOCK_CHANNEL_ID || 'e2e-rel';
const SECRET = process.env.MOCK_SECRET || 'rel-secret';
const REPLY_DELAY_MS = Number(process.env.MOCK_REPLY_DELAY_MS || '50');
const DROP_REPLY_TO = process.env.MOCK_DROP_REPLY_TO === '1';
const NEVER_REPLY = process.env.MOCK_NEVER_REPLY === '1';
const INSTANCE_ID = process.env.MOCK_INSTANCE_ID || 'mock-backend';
// MSG-FLOW regression: simulate the pre-fix channel bug where the channel
// re-broadcasts the inbound user message back to gateway as a `message.send`,
// which gateway then persists as an outbound row carrying the user's text.
// Off by default; enable to prove the bug exists pre-fix.
const ECHO_INBOUND_AS_OUTBOUND = process.env.MOCK_ECHO_INBOUND_AS_OUTBOUND === '1';

let ws;
let reconnectTimer;

function log(...args) {
  console.log('[mock]', new Date().toISOString(), ...args);
}

function connect() {
  log('connecting to', RELAY_URL);
  ws = new WebSocket(RELAY_URL);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'relay.backend.hello',
      channelId: CHANNEL_ID,
      secret: SECRET,
      instanceId: INSTANCE_ID,
      timestamp: Date.now(),
    }));
  });

  ws.on('message', (raw) => {
    let f;
    try { f = JSON.parse(raw.toString()); } catch { return; }

    if (f.type === 'relay.backend.ack') {
      log('handshake ack');
      return;
    }
    if (f.type === 'relay.backend.error') {
      log('handshake error:', f.message);
      return;
    }

    if (f.type === 'relay.client.open') {
      // Acknowledge by responding with agent.list so client knows what's available.
      ws.send(JSON.stringify({
        type: 'relay.server.event',
        connectionId: f.connectionId,
        event: {
          type: 'agent.list',
          data: {
            requestId: 'mock-init',
            agents: [
              { id: 'main', name: 'main', model: 'mock-1.0', isDefault: true, status: 'online' },
            ],
            defaultAgentId: 'main',
            selectedAgentId: 'main',
            timestamp: Date.now(),
          },
        },
        timestamp: Date.now(),
      }));
      return;
    }

    if (f.type === 'relay.client.event') {
      const evt = f.event;
      if (evt.type === 'message.receive') {
        if (ECHO_INBOUND_AS_OUTBOUND) {
          // Pre-fix bug repro: re-emit the inbound payload as a `message.send`
          // back to gateway, mirroring what channel/src/generic/client.ts used
          // to do via broadcastToChatExcept. Gateway persists this as a
          // direction='outbound' row with the user's original messageId/content.
          ws.send(JSON.stringify({
            type: 'relay.server.event',
            connectionId: f.connectionId,
            event: {
              type: 'message.send',
              data: {
                messageId: evt.data.messageId,
                chatId: evt.data.chatId,
                agentId: evt.data.agentId,
                senderId: evt.data.senderId,
                content: evt.data.content,
                contentType: evt.data.messageType || 'text',
                timestamp: evt.data.timestamp || Date.now(),
                direction: 'inbound',
                echo: true,
              },
            },
            timestamp: Date.now(),
          }));
        }
        if (NEVER_REPLY) {
          log('NEVER_REPLY mode: dropping', evt.data.messageId);
          return;
        }
        // REL-06 per-chatId behavior modes (guardrail tests for inbound persistence).
        // Detected by chatId substring so a single mock-backend can serve all modes.
        const chatId = evt.data?.chatId || '';
        if (chatId.includes('rel-06-timeout') || chatId.includes('rel-06-drop')) {
          log(`mode=silent (${chatId}): not replying to`, evt.data.messageId);
          return;
        }
        if (chatId.includes('rel-06-reject')) {
          log(`mode=reject (${chatId}): sending relay.server.reject for`, evt.data.messageId);
          ws.send(JSON.stringify({
            type: 'relay.server.reject',
            connectionId: f.connectionId,
            code: 1008,
            message: 'mock-backend rejected (REL-06b)',
            timestamp: Date.now(),
          }));
          return;
        }
        // REL-07 streaming modes — emit text.delta frames before message.send
        // so SSE callers can verify intermediate event delivery.
        //   rel-07-stream → 3 deltas, ~150ms apart, then done
        //   rel-07-long   → deltas every 1s for 12s, then done (exceeds the
        //                   old 600s cap is overkill; 12s is enough to prove
        //                   the SSE path doesn't impose a request-level deadline)
        if (chatId.includes('rel-07-stream') || chatId.includes('rel-07-long')) {
          const isLong = chatId.includes('rel-07-long');
          const deltaCount = isLong ? 12 : 3;
          const intervalMs = isLong ? 1000 : 150;
          const baseReply = `MOCK_REPLY: ${evt.data.content}`;
          let i = 0;
          const tick = () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (i < deltaCount) {
              ws.send(JSON.stringify({
                type: 'relay.server.event',
                connectionId: f.connectionId,
                event: {
                  type: 'text.delta',
                  data: {
                    chatId: evt.data.chatId,
                    content: `chunk-${i} `,
                    index: i,
                    timestamp: Date.now(),
                  },
                },
                timestamp: Date.now(),
              }));
              i++;
              setTimeout(tick, intervalMs);
              return;
            }
            const replyData = {
              messageId: `mock-${Date.now()}-${randomUUID().slice(0, 8)}`,
              chatId: evt.data.chatId,
              content: baseReply,
              contentType: 'text',
              agentId: evt.data.agentId || 'main',
              timestamp: Date.now(),
              meta: { model: 'mock-1.0', deltaCount },
            };
            if (evt.data.threadId) replyData.threadId = evt.data.threadId;
            if (!DROP_REPLY_TO) replyData.replyTo = evt.data.messageId;
            ws.send(JSON.stringify({
              type: 'relay.server.event',
              connectionId: f.connectionId,
              event: { type: 'message.send', data: replyData },
              timestamp: Date.now(),
            }));
          };
          setTimeout(tick, intervalMs);
          return;
        }
        const replyData = {
          messageId: `mock-${Date.now()}-${randomUUID().slice(0, 8)}`,
          chatId: evt.data.chatId,
          content: `MOCK_REPLY: ${evt.data.content}`,
          contentType: 'text',
          agentId: evt.data.agentId || 'main',
          timestamp: Date.now(),
          meta: { model: 'mock-1.0' },
        };
        if (evt.data.threadId) replyData.threadId = evt.data.threadId;
        if (!DROP_REPLY_TO) replyData.replyTo = evt.data.messageId;

        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            type: 'relay.server.event',
            connectionId: f.connectionId,
            event: { type: 'message.send', data: replyData },
            timestamp: Date.now(),
          }));
        }, REPLY_DELAY_MS);
      } else if (evt.type === 'agent.list.get') {
        // Some clients call this on connect.
        ws.send(JSON.stringify({
          type: 'relay.server.event',
          connectionId: f.connectionId,
          event: {
            type: 'agent.list',
            data: {
              requestId: evt.data?.requestId,
              agents: [
                { id: 'main', name: 'main', model: 'mock-1.0', isDefault: true, status: 'online' },
              ],
              defaultAgentId: 'main',
              selectedAgentId: 'main',
              timestamp: Date.now(),
            },
          },
          timestamp: Date.now(),
        }));
      }
    }
  });

  ws.on('close', (code, reason) => {
    log('close', code, String(reason || ''));
    if (process.env.MOCK_NO_RECONNECT !== '1') {
      reconnectTimer = setTimeout(connect, 1000);
    } else {
      process.exit(0);
    }
  });

  ws.on('error', (e) => log('error:', e.message));
}

connect();

const shutdown = () => {
  clearTimeout(reconnectTimer);
  process.env.MOCK_NO_RECONNECT = '1';
  try { ws?.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

# Clawline reliability test infrastructure.
#
# Targets:
#   make dev-reset         — kill any test-gateway + mock-backend; start fresh test-gateway
#   make mock-backend      — start mock-backend (auto-respawn on close)
#   make test-reliability  — full REL-01..05 cycle (deps: dev-reset + mock-backend)
#   make clean             — kill test-gateway + mock-backend started by this Makefile
#
# Conventions:
#   Test gateway runs on 19181 (separate from dev gateway @ 19180).
#   We never touch port 19180, the launchd-managed OpenClaw, or any user processes.
#   Test data uses channel `e2e-rel` (cleaned at start of each test run).

GATEWAY_DIR := .
TEST_GW_PORT := 19181
TEST_GW_PIDFILE := /tmp/clawline-test-gw.pid
MOCK_PIDFILE := /tmp/clawline-mock-backend.pid
GW_LOG := /tmp/clawline-test-gw.log
MOCK_LOG := /tmp/clawline-mock-backend.log

.PHONY: dev-reset mock-backend test-reliability clean _stop-gw _stop-mock

dev-reset: _stop-gw
	@echo "→ Starting test-gateway on $(TEST_GW_PORT)…"
	@cd $(GATEWAY_DIR) && nohup node --env-file=.env.test server.js < /dev/null > $(GW_LOG) 2>&1 & echo $$! > $(TEST_GW_PIDFILE)
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	  sleep 1; \
	  if curl -sf http://localhost:$(TEST_GW_PORT)/healthz > /dev/null 2>&1; then \
	    echo "✓ test-gateway ready (PID $$(cat $(TEST_GW_PIDFILE)))"; exit 0; \
	  fi; \
	done; \
	echo "✗ test-gateway failed to start; tail of log:"; tail -20 $(GW_LOG); exit 1

mock-backend: _stop-mock
	@echo "→ Starting mock-backend…"
	@cd $(GATEWAY_DIR) && nohup node test/mock-backend.js < /dev/null > $(MOCK_LOG) 2>&1 & echo $$! > $(MOCK_PIDFILE)
	@sleep 1
	@if kill -0 $$(cat $(MOCK_PIDFILE)) 2>/dev/null; then \
	  echo "✓ mock-backend running (PID $$(cat $(MOCK_PIDFILE)))"; \
	else \
	  echo "✗ mock-backend died; log:"; tail -20 $(MOCK_LOG); exit 1; \
	fi

test-reliability: dev-reset mock-backend
	@echo ""
	@echo "→ Running REL-01..05…"
	@cd $(GATEWAY_DIR) && node test/rel-suite.js; \
	  rc=$$?; \
	  echo ""; \
	  if [ $$rc -eq 0 ]; then echo "✓ REL suite PASS"; else echo "✗ REL suite FAIL (rc=$$rc)"; fi; \
	  $(MAKE) clean > /dev/null 2>&1; \
	  exit $$rc

clean: _stop-gw _stop-mock
	@echo "✓ test infra clean"

_stop-gw:
	@if [ -f $(TEST_GW_PIDFILE) ]; then \
	  PID=$$(cat $(TEST_GW_PIDFILE)); \
	  if kill -0 $$PID 2>/dev/null; then kill $$PID 2>/dev/null && echo "→ stopped test-gateway PID $$PID"; fi; \
	  rm -f $(TEST_GW_PIDFILE); \
	fi
	@# pidfile tracks the sh wrapper that spawned node; sweep the actual node by env file
	@pkill -f 'node --env-file=.env.test' 2>/dev/null && echo "→ swept orphan test-gateway node(s)" || true

_stop-mock:
	@if [ -f $(MOCK_PIDFILE) ]; then \
	  PID=$$(cat $(MOCK_PIDFILE)); \
	  if kill -0 $$PID 2>/dev/null; then kill $$PID 2>/dev/null && echo "→ stopped mock-backend PID $$PID"; fi; \
	  rm -f $(MOCK_PIDFILE); \
	fi
	@# REL-03 respawns mock-backend on a different PID — sweep any orphans
	@pkill -f "test/mock-backend.js" 2>/dev/null && echo "→ swept orphan mock-backend(s)" || true

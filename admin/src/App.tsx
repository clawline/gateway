import { useEffect, useState, useCallback, Component, type FormEvent, type ReactNode, type ErrorInfo } from 'react';
import { useLogto, type IdTokenClaims } from '@logto/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  Activity,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Database,
  Globe,
  Hexagon,
  CircleAlert,
  Lock,
  LogOut,
  MessageSquare,
  Mic,
  Network,
  Pencil,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  Server,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── QR Code via external API ─────────────────────────────────

const QRCodeImage = ({ value, size }: { value: string; size: number }) => {
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(value)}`;
  return <img src={src} alt="QR code" width={size} height={size} className="block" />;
};

// ── Types ────────────────────────────────────────────────────

type RelayUser = {
  id: string;
  senderId: string;
  chatId?: string;
  token: string;
  allowAgents?: string[];
  enabled: boolean;
};

type RelayChannel = {
  channelId: string;
  label?: string;
  secret: string;
  secretMasked: string;
  tokenParam: string;
  userCount: number;
  users: RelayUser[];
  backendConnected: boolean;
  clientCount: number;
  instanceId?: string;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
};

type RelayState = {
  ok: true;
  configPath: string;
  adminAuthEnabled: boolean;
  publicBaseUrl?: string;
  pluginBackendUrl?: string;
  channels: RelayChannel[];
  stats: {
    backendCount: number;
    clientCount: number;
  };
  timestamp: number;
};

type ChannelFormValues = {
  channelId: string;
  label: string;
  secret: string;
};

type UserFormValues = {
  senderId: string;
  chatId: string;
  token: string;
  allowAgents: string;
  enabled: boolean;
};

type ChannelModalState = { mode: 'create' | 'edit'; channel?: RelayChannel } | null;
type UserModalState = { mode: 'create' | 'edit'; user?: RelayUser } | null;

type DialogAccent = 'cyan' | 'fuchsia' | 'rose';

type AppDialogConfig = {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  accent?: DialogAccent;
  onConfirm?: () => Promise<void> | void;
};

type AppDialogState = ({ mode: 'alert' | 'confirm' } & AppDialogConfig) | null;

// ── Constants ────────────────────────────────────────────────

const LOGTO_APP_ID = 'anbr9zjc6bgd8099ecnx3';
const GATEWAY_NAME = 'CLAWLINE_GATEWAY';
const REFRESH_INTERVAL = 30_000; // 30 seconds

// ── Multi-Relay Registry ─────────────────────────────────────

type RelayNode = {
  id: string;
  name: string;
  url: string;
  adminToken: string;
};

const RELAY_REGISTRY_KEY = 'relay-registry';
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const DEFAULT_RELAY: RelayNode = { id: 'default', name: isLocal ? 'localhost' : 'relay.restry.cn', url: isLocal ? window.location.origin : 'https://relay.restry.cn', adminToken: isLocal ? 'local-test-token' : '5ff160a5089321692679f5a8442686b8' };

function loadRelayRegistryLocal(): RelayNode[] {
  // On localhost, always use the local gateway as default
  if (isLocal) return [DEFAULT_RELAY];
  try {
    const raw = localStorage.getItem(RELAY_REGISTRY_KEY);
    if (!raw) return [DEFAULT_RELAY];
    const parsed = JSON.parse(raw) as RelayNode[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [DEFAULT_RELAY];
  } catch { return [DEFAULT_RELAY]; }
}

function saveRelayRegistryLocal(nodes: RelayNode[]) {
  localStorage.setItem(RELAY_REGISTRY_KEY, JSON.stringify(nodes));
}

async function fetchRelayNodesFromServer(gatewayRelay: RelayNode, accessToken?: string): Promise<RelayNode[] | null> {
  try {
    const nodes = await apiFetch<{ ok: boolean; nodes: RelayNode[] }>('/api/relay-nodes', gatewayRelay, undefined, accessToken);
    if (nodes.ok && Array.isArray(nodes.nodes) && nodes.nodes.length > 0) {
      saveRelayRegistryLocal(nodes.nodes);
      return nodes.nodes;
    }
  } catch { /* fall through */ }
  return null;
}

async function saveRelayNodeToServer(node: RelayNode, gatewayRelay: RelayNode, accessToken?: string): Promise<boolean> {
  try {
    await apiFetch('/api/relay-nodes', gatewayRelay, { method: 'POST', body: JSON.stringify(node) }, accessToken);
    return true;
  } catch { return false; }
}

async function deleteRelayNodeFromServer(nodeId: string, gatewayRelay: RelayNode, accessToken?: string): Promise<boolean> {
  try {
    await apiFetch(`/api/relay-nodes/${encodeURIComponent(nodeId)}`, gatewayRelay, { method: 'DELETE' }, accessToken);
    return true;
  } catch { return false; }
}

// ── API ──────────────────────────────────────────────────────

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function randomToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomChannelName() {
  const fruits: [string, string][] = [
    ['🍎', 'apple'], ['🍌', 'banana'], ['🍒', 'cherry'], ['🐉', 'dragon-fruit'], ['🫐', 'elderberry'],
    ['🪴', 'fig'], ['🍇', 'grape'], ['🍈', 'honeydew'], ['🥝', 'kiwi'], ['🍋', 'lemon'],
    ['🥭', 'mango'], ['🍑', 'nectarine'], ['🍊', 'orange'], ['🧡', 'papaya'], ['🍐', 'quince'],
    ['🫐', 'raspberry'], ['🍓', 'strawberry'], ['🍊', 'tangerine'], ['🍉', 'watermelon'], ['💙', 'blueberry'],
  ];
  const [emoji, name] = fruits[Math.floor(Math.random() * fruits.length)];
  return { id: name, label: `${emoji} ${name}` };
}

function randomSenderId() {
  const animals = [
    'falcon', 'tiger', 'wolf', 'panther', 'eagle', 'hawk', 'cobra', 'viper',
    'lynx', 'fox', 'bear', 'shark', 'whale', 'dolphin', 'otter', 'raven',
    'owl', 'crane', 'heron', 'jaguar', 'leopard', 'puma', 'cheetah', 'bison',
  ];
  return animals[Math.floor(Math.random() * animals.length)];
}

function normalizeBaseUrl(value?: string) {
  return value?.replace(/\/+$/, '') ?? '';
}

function httpToWs(url: string) {
  if (url.startsWith('https://')) return `wss://${url.slice(8)}`;
  if (url.startsWith('http://')) return `ws://${url.slice(7)}`;
  return url;
}

function buildGatewayEndpoint(state: RelayState | null) {
  if (!state) return window.location.origin;
  return normalizeBaseUrl(state.publicBaseUrl) || normalizeBaseUrl(state.pluginBackendUrl) || window.location.origin;
}

function buildPluginConfig(channel: RelayChannel, backendEndpoint: string) {
  return JSON.stringify({
    channels: {
      clawline: {
        enabled: true,
        connectionMode: 'relay',
        relay: {
          url: backendEndpoint,
          channelId: channel.channelId,
          secret: channel.secret,
          instanceId: `openclaw-${channel.channelId.toLowerCase()}-${randomToken().slice(0, 8)}`,
        },
      },
    },
  }, null, 2);
}

function buildClientConnectUrl(state: RelayState | null, channel: RelayChannel, user: RelayUser) {
  const base = normalizeBaseUrl(state?.publicBaseUrl) || window.location.origin;
  const wsBase = httpToWs(base);
  // chatId defaults to senderId for DM routing — OpenClaw uses senderId as the message target
  const effectiveChatId = user.chatId || user.senderId;
  const serverUrl = `${wsBase}/client?channelId=${encodeURIComponent(channel.channelId)}&token=${encodeURIComponent(user.token)}${effectiveChatId ? `&chatId=${encodeURIComponent(effectiveChatId)}` : ''}`;
  const params = new URLSearchParams();
  params.set('serverUrl', serverUrl);
  if (user.senderId) params.set('senderId', user.senderId);
  if (channel.label || channel.channelId) params.set('displayName', `${channel.label || channel.channelId}/${user.senderId || 'user'}`);
  if (channel.label) params.set('channelName', channel.label);
  if (channel.channelId) params.set('channelId', channel.channelId);
  return `openclaw://connect?${params.toString()}`;
}

function formatTimestamp(timestamp?: number) {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleString();
}

function relativeTime(ts: number | string): string {
  const now = Date.now();
  const then = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  const diffMs = now - then;
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function buildDiagnosticLines(state: RelayState) {
  const lines = [
    `INFO: CONFIG_PATH=${state.configPath}`,
    `INFO: PUBLIC_BASE_URL=${state.publicBaseUrl ?? 'UNSET'}`,
    `INFO: PLUGIN_BACKEND_URL=${state.pluginBackendUrl ?? 'UNSET'}`,
    `INFO: CHANNELS=${state.channels.length} BACKENDS=${state.stats.backendCount} CLIENTS=${state.stats.clientCount}`,
  ];
  if (state.channels.length === 0) {
    lines.push('WARN: NO_CHANNELS_REGISTERED');
    return lines;
  }
  for (const ch of state.channels) {
    lines.push(`INFO: CHANNEL=${ch.channelId} LABEL=${ch.label ?? 'UNSET'} BACKEND=${ch.backendConnected ? 'ONLINE' : 'OFFLINE'} CLIENTS=${ch.clientCount} USERS=${ch.userCount}`);
    lines.push(`INFO: CHANNEL=${ch.channelId} TOKEN_PARAM=${ch.tokenParam} SECRET=${ch.secretMasked}`);
    if (ch.instanceId) lines.push(`INFO: CHANNEL=${ch.channelId} INSTANCE_ID=${ch.instanceId}`);
    else lines.push(`WARN: CHANNEL=${ch.channelId} INSTANCE_ID=UNBOUND`);
    if (ch.lastConnectedAt) lines.push(`INFO: CHANNEL=${ch.channelId} LAST_CONNECTED=${formatTimestamp(ch.lastConnectedAt)}`);
    if (ch.lastDisconnectedAt) lines.push(`WARN: CHANNEL=${ch.channelId} LAST_DISCONNECTED=${formatTimestamp(ch.lastDisconnectedAt)}`);
  }
  return lines;
}

async function parseApiError(response: Response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string') return payload.error;
  } catch { /* ignore */ }
  return `${response.status} ${response.statusText}`.trim();
}

async function apiFetch<T>(path: string, relay: RelayNode, init?: RequestInit, accessToken?: string) {
  const headers = new Headers(init?.headers);
  if (relay.adminToken) headers.set('x-relay-admin-token', relay.adminToken);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const url = `${relay.url.replace(/\/+$/, '')}${path}`;
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new ApiError(response.status, await parseApiError(response));
  return (await response.json()) as T;
}

// ── Shared UI Components ─────────────────────────────────────

const inputClassName =
  'w-full bg-[#fafafc] border-[3px] border-black/[0.04] rounded-[11px] p-3 text-[#1d1d1f] focus:outline-none focus:border-[#0071e3] focus:ring-2 focus:ring-[#0071e3]/20 transition-all text-sm placeholder:text-black/30';

const labelClassName = 'text-[11px] font-semibold text-black/48 tracking-wide uppercase';

const CopyBtn = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button type="button" onClick={handleCopy} className="text-black/30 hover:text-[#0071e3] transition-colors">
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

const Panel = ({ title, icon: Icon, children, className }: {
  title: string;
  icon: typeof Server;
  children: ReactNode;
  className?: string;
}) => (
  <div className={cn('bg-white rounded-lg flex flex-col overflow-hidden shadow-[rgba(0,0,0,0.12)_0px_4px_24px_0px]', className)}>
    <div className="flex items-center gap-1.5 px-4 py-3 border-b border-black/[0.06]">
      <Icon className="w-3.5 h-3.5 text-[#0071e3]" strokeWidth={1.8} />
      <span className="text-[11px] font-semibold text-black/48 tracking-widest uppercase">{title}</span>
    </div>
    <div className="p-4 flex-1 relative z-10 overflow-y-auto">{children}</div>
  </div>
);

const StatusDot = ({ active }: { active: boolean }) => (
  <span className={cn('inline-flex items-center gap-1.5 text-[10px] tracking-wider',
    active ? 'text-emerald-600' : 'text-black/30',
  )}>
    <span className={cn('w-1.5 h-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-black/20')} />
    {active ? 'ONLINE' : 'OFFLINE'}
  </span>
);

const ModalShell = ({
  accent = 'cyan',
  title,
  icon: Icon,
  children,
  onClose,
  maxWidth = 'max-w-2xl',
  closeDisabled = false,
}: {
  accent?: DialogAccent;
  title: string;
  icon: typeof Activity;
  children: ReactNode;
  onClose: () => void;
  maxWidth?: string;
  closeDisabled?: boolean;
}) => {
  useEffect(() => {
    if (closeDisabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeDisabled, onClose]);

  const isDanger = accent === 'rose';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className={cn('w-full bg-[#1c1c1e] flex flex-col max-h-[90vh] rounded-xl overflow-hidden', maxWidth)}>
        <div className="px-5 py-4 border-b border-white/[0.08] flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Icon className={cn('w-4 h-4', isDanger ? 'text-red-400' : 'text-white')} strokeWidth={1.8} />
            <span className="text-sm font-semibold text-white tracking-tight">{title}</span>
          </div>
          <button type="button" onClick={onClose} disabled={closeDisabled}
            className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/60 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-30">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="overflow-y-auto text-white/80">
          {children}
        </div>
      </div>
    </div>
  );
};

// ── Node Config Modal ────────────────────────────────────────

const NodeConfigModal = ({ channel, backendEndpoint, onClose }: {
  channel: RelayChannel | null;
  backendEndpoint: string;
  onClose: () => void;
}) => {
  if (!channel) return null;
  const configJson = buildPluginConfig(channel, backendEndpoint);
  return (
    <ModalShell title="NODE_CONFIG" icon={Settings} onClose={onClose}>
      <div className="p-5 text-sm relative group overflow-y-auto">
        <div className="absolute top-5 right-5 opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyBtn text={configJson} />
        </div>
        <div className="space-y-1 text-white/40 mb-4 text-xs">
          <div>// Backend: <span className="text-[#2997ff]">{backendEndpoint}</span></div>
          <div>// Channel: <span className="text-[#2997ff]">{channel.channelId}</span></div>
        </div>
        <pre className="text-white/80 leading-relaxed overflow-x-auto text-xs">{configJson}</pre>
      </div>
    </ModalShell>
  );
};

// ── User Connect Modal ───────────────────────────────────────

const UserConnectModal = ({ user, channel, relayState, onClose }: {
  user: RelayUser | null;
  channel: RelayChannel | null;
  relayState: RelayState | null;
  onClose: () => void;
}) => {
  if (!user || !channel) return null;
  const connectionUrl = buildClientConnectUrl(relayState, channel, user);
  return (
    <ModalShell title="CONNECTION_PARAMS" icon={QrCode} onClose={onClose} maxWidth="max-w-lg">
      <div className="p-6 flex flex-col items-center gap-5 overflow-y-auto">
        <div className="w-full grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm bg-white/5 rounded-lg p-4">
          <span className="text-white/40 text-xs">NODE</span>
          <span className="text-white">{channel.label || channel.channelId}</span>
          <span className="text-white/40 text-xs">USER</span>
          <span className="text-white">{user.senderId}</span>
          <span className="text-white/40 text-xs">TOKEN</span>
          <span className="text-white/70 text-xs">{user.token.slice(0, 8)}…{user.token.slice(-4)}</span>
        </div>
        <div className="p-3 bg-white rounded-lg">
          <QRCodeImage value={connectionUrl} size={180} />
        </div>
        <div className="w-full space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs text-white/40 tracking-widest uppercase">Connect URL</span>
            <CopyBtn text={connectionUrl} />
          </div>
          <div className="p-3 bg-white/5 rounded-lg text-xs text-[#2997ff] break-all">{connectionUrl}</div>
        </div>
      </div>
    </ModalShell>
  );
};

// ── Diagnostic Modal ─────────────────────────────────────────

const DiagnosticModal = ({ isOpen, isLoading, lines, onClose }: {
  isOpen: boolean;
  isLoading: boolean;
  lines: string[];
  onClose: () => void;
}) => {
  if (!isOpen) return null;
  return (
    <ModalShell title="Diagnostic Report" icon={Activity} onClose={onClose}>
      <div className="p-5 space-y-2 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center gap-3 text-white/60 animate-pulse py-4">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span className="text-sm">Scanning…</span>
          </div>
        ) : lines.map((line, i) => (
          <div key={`${line}-${i}`} className={cn('rounded-lg px-3 py-2 text-xs',
            line.includes('ERR') ? 'bg-red-500/10 text-red-300 border-l-2 border-red-400' :
            line.includes('WARN') ? 'bg-amber-500/10 text-amber-300 border-l-2 border-amber-400' :
            'bg-white/5 text-white/60',
          )}>
            <span className="text-white/30 mr-2">[{new Date().toLocaleTimeString()}]</span>
            {line}
          </div>
        ))}
      </div>
    </ModalShell>
  );
};

// ── Confirm Dialog ───────────────────────────────────────────

const AppDialogModal = ({ state, isSubmitting, error, onClose, onConfirm }: {
  state: AppDialogState;
  isSubmitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) => {
  if (!state) return null;
  const isConfirm = state.mode === 'confirm';
  const isDanger = state.accent === 'rose';
  return (
    <ModalShell title={state.title} icon={isDanger ? ShieldAlert : Activity} accent={state.accent} onClose={onClose} maxWidth="max-w-md" closeDisabled={isSubmitting}>
      <div className="p-6 space-y-4 overflow-y-auto">
        <p className="text-white/80 text-[15px] leading-relaxed whitespace-pre-wrap">{state.message}</p>
        {state.detail && <p className="text-sm text-white/40 leading-relaxed">{state.detail}</p>}
        {error && <div className="text-red-300 text-sm bg-red-500/10 rounded-lg px-4 py-3">{error}</div>}
        <div className="flex justify-end gap-3 pt-1">
          {isConfirm && (
            <button type="button" onClick={onClose} disabled={isSubmitting}
              className="px-5 py-2 rounded-lg text-sm text-white/70 bg-white/10 hover:bg-white/15 transition-colors disabled:opacity-40">
              {state.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button type="button" onClick={onConfirm} disabled={isSubmitting}
            className={cn('min-w-[80px] px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2',
              isDanger ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-[#0071e3] text-white hover:bg-[#0077ed]',
            )}>
            {isSubmitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : state.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
};

// ── Channel Form Modal ───────────────────────────────────────

const ChannelFormModal = ({ state, onClose, onSubmit, isSubmitting, submitSuccess, error }: {
  state: ChannelModalState;
  onClose: () => void;
  onSubmit: (values: ChannelFormValues) => Promise<void>;
  isSubmitting: boolean;
  submitSuccess: boolean;
  error: string | null;
}) => {
  const [form, setForm] = useState<ChannelFormValues>(() => {
    const g = randomChannelName();
    return { channelId: state?.channel?.channelId ?? g.id, label: state?.channel?.label ?? g.label, secret: state?.channel?.secret ?? randomToken() };
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!state) return;
    const g = randomChannelName();
    setForm({ channelId: state.channel?.channelId ?? g.id, label: state.channel?.label ?? g.label, secret: state.channel?.secret ?? randomToken() });
    setShowAdvanced(state.mode === 'edit');
  }, [state]);

  if (!state) return null;
  const isEdit = state.mode === 'edit';

  return (
    <ModalShell title={isEdit ? 'Edit Channel' : 'New Channel'} icon={Network} onClose={onClose} closeDisabled={isSubmitting || submitSuccess}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void onSubmit(form); }} className="p-6 space-y-5 overflow-y-auto">
        <p className="text-sm text-white/40">{isEdit ? 'Modify channel configuration.' : 'Auto-generated defaults — expand Advanced to customize.'}</p>
        <div className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-3">
          <div className="text-sm text-white/70">
            <span className="text-white font-medium">{form.label || form.channelId}</span>
            {form.label && <span className="text-white/30 ml-2 text-xs">{form.channelId}</span>}
          </div>
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-sm text-[#2997ff] hover:underline">
            {showAdvanced ? 'Collapse' : 'Advanced'}
          </button>
        </div>
        {showAdvanced && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="ch-id" className={labelClassName}>Channel ID</label>
              <input id="ch-id" value={form.channelId} onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
                className={inputClassName} disabled={isEdit || isSubmitting} />
            </div>
            <div className="space-y-2">
              <label htmlFor="ch-label" className={labelClassName}>Label</label>
              <input id="ch-label" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                className={inputClassName} disabled={isSubmitting} />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label htmlFor="ch-secret" className={labelClassName}>Secret</label>
                <button type="button" onClick={() => setForm((f) => ({ ...f, secret: randomToken() }))}
                  className="text-sm text-[#2997ff] hover:underline" disabled={isSubmitting}>Regenerate</button>
              </div>
              <input id="ch-secret" value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                className={inputClassName} disabled={isSubmitting} />
            </div>
          </div>
        )}
        {error && <div className="text-red-300 text-sm bg-red-500/10 rounded-lg px-4 py-3">{error}</div>}
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="px-5 py-2 rounded-lg text-sm text-white/70 bg-white/10 hover:bg-white/15 transition-colors" disabled={isSubmitting}>Cancel</button>
          <button type="submit" disabled={isSubmitting || submitSuccess}
            className={cn('min-w-[80px] px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2',
              submitSuccess ? 'bg-emerald-500 text-white' : 'bg-[#0071e3] text-white hover:bg-[#0077ed]')}>
            {submitSuccess ? <><Check className="w-4 h-4" />Saved</> : isSubmitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : isEdit ? 'Update' : 'Create'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};

// ── User Form Modal ──────────────────────────────────────────

const UserFormModal = ({ state, channel, onClose, onSubmit, isSubmitting, submitSuccess, error }: {
  state: UserModalState;
  channel: RelayChannel | null;
  onClose: () => void;
  onSubmit: (values: UserFormValues) => Promise<void>;
  isSubmitting: boolean;
  submitSuccess: boolean;
  error: string | null;
}) => {
  const [form, setForm] = useState<UserFormValues>({
    senderId: state?.user?.senderId ?? randomSenderId(),
    chatId: state?.user?.chatId ?? '',
    token: state?.user?.token ?? randomToken(),
    allowAgents: state?.user?.allowAgents?.join(', ') ?? '',
    enabled: state?.user?.enabled ?? true,
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!state) return;
    setForm({
      senderId: state.user?.senderId ?? randomSenderId(),
      chatId: state.user?.chatId ?? '',
      token: state.user?.token ?? randomToken(),
      allowAgents: state.user?.allowAgents?.join(', ') ?? '',
      enabled: state.user?.enabled ?? true,
    });
    setShowAdvanced(state.mode === 'edit');
  }, [state]);

  if (!state || !channel) return null;
  const isEdit = state.mode === 'edit';

  return (
    <ModalShell title={isEdit ? 'Edit User' : 'Add User'} icon={Users} onClose={onClose} closeDisabled={isSubmitting || submitSuccess}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void onSubmit(form); }} className="p-6 space-y-5 overflow-y-auto">
        <p className="text-sm text-white/40">Channel: <span className="text-[#2997ff]">{channel.channelId}</span></p>
        <div className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-3">
          <span className="text-sm text-white font-medium">{form.senderId}</span>
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-sm text-[#2997ff] hover:underline">
            {showAdvanced ? 'Collapse' : 'Advanced'}
          </button>
        </div>
        {showAdvanced && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="u-sid" className={labelClassName}>Sender ID</label>
              <input id="u-sid" value={form.senderId} onChange={(e) => setForm((f) => ({ ...f, senderId: e.target.value }))}
                className={inputClassName} disabled={isEdit || isSubmitting} />
            </div>
            <div className="space-y-2">
              <label htmlFor="u-cid" className={labelClassName}>Chat ID</label>
              <input id="u-cid" value={form.chatId} onChange={(e) => setForm((f) => ({ ...f, chatId: e.target.value }))}
                className={inputClassName} placeholder="optional" disabled={isSubmitting} />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label htmlFor="u-tok" className={labelClassName}>Token</label>
                <button type="button" onClick={() => setForm((f) => ({ ...f, token: randomToken() }))}
                  className="text-sm text-[#2997ff] hover:underline" disabled={isSubmitting}>Regenerate</button>
              </div>
              <input id="u-tok" value={form.token} onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                className={inputClassName} disabled={isSubmitting} />
            </div>
            <div className="space-y-2">
              <label htmlFor="u-agents" className={labelClassName}>Allow Agents</label>
              <input id="u-agents" value={form.allowAgents} onChange={(e) => setForm((f) => ({ ...f, allowAgents: e.target.value }))}
                className={inputClassName} placeholder="Comma-separated, blank = all" disabled={isSubmitting} />
            </div>
            <label className="flex items-center gap-3 text-sm text-white/70 cursor-pointer select-none">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                className="accent-[#0071e3] w-4 h-4" disabled={isSubmitting} />
              Enabled
            </label>
          </div>
        )}
        {error && <div className="text-red-300 text-sm bg-red-500/10 rounded-lg px-4 py-3">{error}</div>}
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="px-5 py-2 rounded-lg text-sm text-white/70 bg-white/10 hover:bg-white/15 transition-colors" disabled={isSubmitting}>Cancel</button>
          <button type="submit" disabled={isSubmitting || submitSuccess}
            className={cn('min-w-[80px] px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2',
              submitSuccess ? 'bg-emerald-500 text-white' : 'bg-[#0071e3] text-white hover:bg-[#0077ed]')}>
            {submitSuccess ? <><Check className="w-4 h-4" />Saved</> : isSubmitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : isEdit ? 'Update' : 'Add'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};

// ═══════════════════════════════════════════════════════════════
// App (Auth Gate)
// ═══════════════════════════════════════════════════════════════

export default function App() {
  const { isAuthenticated: isLogtoAuth, isLoading: isLogtoLoading, signIn, signOut, getIdTokenClaims } = useLogto();
  const [logtoUser, setLogtoUser] = useState<IdTokenClaims | null>(null);

  // Dev bypass: skip Logto auth on localhost
  const isDevBypass = isLocal && !isLogtoAuth && !isLogtoLoading;

  useEffect(() => {
    if (isLogtoAuth) {
      void getIdTokenClaims().then((claims) => { if (claims) setLogtoUser(claims); });
    } else {
      setLogtoUser(null);
    }
  }, [isLogtoAuth, getIdTokenClaims]);

  if (isLogtoLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center space-y-5">
          <Hexagon className="w-10 h-10 text-white/20 mx-auto animate-pulse" strokeWidth={1} />
          <p className="text-xs tracking-[0.2em] text-white/30 uppercase">Initializing</p>
        </div>
      </div>
    );
  }

  if (!isLogtoAuth && !isDevBypass) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="w-full max-w-sm px-8 text-center space-y-8">
          <Hexagon className="w-12 h-12 text-white mx-auto" strokeWidth={1} />
          <div className="space-y-3">
            <h1 style={{ fontSize: '28px', fontWeight: 600, lineHeight: 1.07, letterSpacing: '-0.28px' }} className="text-white">{GATEWAY_NAME}</h1>
            <p className="text-white/50 text-[17px]">Sign in to continue.</p>
          </div>
          <button type="button" onClick={() => void signIn({
            redirectUri: window.location.origin + '/callback',
            postRedirectUri: window.location.origin + '/',
            clearTokens: true,
          })}
            style={{ borderRadius: '980px' }}
            className="w-full py-3 bg-[#0071e3] text-white text-[17px] hover:bg-[#0077ed] transition-colors flex justify-center items-center gap-2">
            <Lock className="w-4 h-4" /> Sign in with SSO
          </button>
        </div>
      </div>
    );
  }

  return (
    <AppErrorBoundary>
      <AdminDashboard logtoUser={logtoUser} onLogtoSignOut={() => void signOut(window.location.origin)} />
    </AppErrorBoundary>
  );
}

// ═══════════════════════════════════════════════════════════════
// AdminDashboard (authenticated)
// ═══════════════════════════════════════════════════════════════

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#020617', color: '#f87171', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', padding: '2rem' }}>
          <div style={{ maxWidth: '600px', textAlign: 'center' }}>
            <h2 style={{ fontSize: '1rem', marginBottom: '1rem' }}>RENDER_ERROR</h2>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.75rem', color: '#fca5a5' }}>{this.state.error.message}\n{this.state.error.stack}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AdminDashboard({ logtoUser, onLogtoSignOut }: {
  logtoUser: IdTokenClaims | null;
  onLogtoSignOut: () => void;
}) {
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [relayState, setRelayState] = useState<RelayState | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // ── Multi-Relay ────────────────────────────────────────────
  const [relayNodes, setRelayNodes] = useState<RelayNode[]>(() => loadRelayRegistryLocal());
  const [selectedRelayId, setSelectedRelayId] = useState<string>(relayNodes[0]?.id ?? 'default');
  const [isRelaySettingsOpen, setIsRelaySettingsOpen] = useState(false);
  const [editingRelay, setEditingRelay] = useState<RelayNode | null>(null);
  const [corsOrigins, setCorsOrigins] = useState<string[]>([]);
  const [corsInput, setCorsInput] = useState('');
  const [corsSaving, setCorsSaving] = useState(false);

  const activeRelay = relayNodes.find((n) => n.id === selectedRelayId) ?? relayNodes[0] ?? DEFAULT_RELAY;
  const gatewayRelay: RelayNode = DEFAULT_RELAY;

  // ── AI Settings ──
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState({ llmEndpoint: '', llmApiKey: '', llmModel: '', suggestionModel: '', replyModel: '', voiceRefineModel: '', suggestionPrompt: '', replyPrompt: '', voiceRefinePrompt: '' });
  const [aiSettingsSaving, setAiSettingsSaving] = useState(false);
  const [aiSettingsTab, setAiSettingsTab] = useState<'provider' | 'suggestions' | 'reply' | 'voice'>('provider');

  const fetchAiSettings = useCallback(async () => {
    try {
      const data = await apiFetch<{ ok: boolean; llmEndpoint?: string; llmApiKey?: string; llmModel?: string; suggestionModel?: string; replyModel?: string; voiceRefineModel?: string; suggestionPrompt?: string; replyPrompt?: string; voiceRefinePrompt?: string }>('/api/ai-settings', activeRelay, undefined);
      if (data.ok) setAiSettings({ llmEndpoint: data.llmEndpoint || '', llmApiKey: '', llmModel: data.llmModel || '', suggestionModel: data.suggestionModel || '', replyModel: data.replyModel || '', voiceRefineModel: data.voiceRefineModel || '', suggestionPrompt: data.suggestionPrompt || '', replyPrompt: data.replyPrompt || '', voiceRefinePrompt: data.voiceRefinePrompt || '' });
    } catch { /* ignore */ }
  }, [activeRelay]);

  const fetchCorsOrigins = useCallback(async () => {
    try {
      const data = await apiFetch<{ ok: boolean; settings?: { corsAllowedOrigins?: string[] }; _env?: { CORS_ALLOWED_ORIGINS?: string[] } }>('/api/settings', activeRelay, undefined);
      const origins = data.settings?.corsAllowedOrigins ?? data._env?.CORS_ALLOWED_ORIGINS ?? [];
      setCorsOrigins(origins);
    } catch { /* ignore */ }
  }, [activeRelay]);

  const saveCorsOrigins = useCallback(async (origins: string[]) => {
    setCorsSaving(true);
    try {
      await apiFetch('/api/settings', activeRelay, { method: 'PUT', body: JSON.stringify({ corsAllowedOrigins: origins }) });
      setCorsOrigins(origins);
    } catch { /* ignore */ }
    setCorsSaving(false);
  }, [activeRelay]);

  const saveAiSettingsHandler = useCallback(async () => {
    setAiSettingsSaving(true);
    try { await apiFetch('/api/ai-settings', activeRelay, { method: 'PUT', body: JSON.stringify(aiSettings) }); } catch { /* ignore */ }
    setAiSettingsSaving(false);
  }, [activeRelay, aiSettings]);

  // ── Message Log ──
  type MessageRow = { id: string; channel_id: string; sender_id: string | null; agent_id: string | null; content: string | null; content_type: string; direction: string; meta: string | null; timestamp: number; created_at: string };
  const [currentView, setCurrentView] = useState<'dashboard' | 'messages'>('dashboard');
  const [messageLogRows, setMessageLogRows] = useState<MessageRow[]>([]);
  const [messageLogTotal, setMessageLogTotal] = useState(0);
  const [messageLogChannel, setMessageLogChannel] = useState('');
  const [messageLogLoading, setMessageLogLoading] = useState(false);
  const [messageLogPage, setMessageLogPage] = useState(0);
  const [messageLogDirection, setMessageLogDirection] = useState<'' | 'inbound' | 'outbound'>('');
  const [messageLogAutoRefresh, setMessageLogAutoRefresh] = useState(false);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const [messageAnalyticsOpen, setMessageAnalyticsOpen] = useState(true);
  const MESSAGE_PAGE_SIZE = 50;

  type StatsData = { hourly: { hour: string; inbound: number; outbound: number }[]; models: { name: string; count: number }[]; channels: { name: string; inbound: number; outbound: number }[] };
  const [messageStats, setMessageStats] = useState<StatsData | null>(null);

  const fetchMessageLog = useCallback(async (opts?: { channel?: string; direction?: string; page?: number }) => {
    setMessageLogLoading(true);
    try {
      const ch = opts?.channel ?? messageLogChannel;
      const dir = opts?.direction ?? messageLogDirection;
      const pg = opts?.page ?? messageLogPage;
      const params = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE), offset: String(pg * MESSAGE_PAGE_SIZE) });
      if (ch) params.set('channelId', ch);
      if (dir) params.set('direction', dir);
      const data = await apiFetch<{ ok: boolean; messages: MessageRow[]; total: number }>(`/api/messages?${params}`, activeRelay, undefined);
      if (data.ok) { setMessageLogRows(data.messages); setMessageLogTotal(data.total); }
    } catch { /* ignore */ }
    setMessageLogLoading(false);
  }, [activeRelay, messageLogChannel, messageLogDirection, messageLogPage]);

  const fetchMessageStats = useCallback(async () => {
    try {
      const data = await apiFetch<{ ok: boolean } & StatsData>('/api/messages/stats', activeRelay, undefined);
      if (data.ok) setMessageStats(data);
    } catch { /* ignore */ }
  }, [activeRelay]);


  const updateRelayNodes = async (next: RelayNode[]) => {
    setRelayNodes(next);
    saveRelayRegistryLocal(next);
  };

  // Load relay nodes from server on mount (skip on localhost — use local gateway)
  useEffect(() => {
    if (isLocal) return;
    (async () => {
      const serverNodes = await fetchRelayNodesFromServer(gatewayRelay);
      if (serverNodes) {
        setRelayNodes(serverNodes);
        if (!serverNodes.find((n) => n.id === selectedRelayId)) {
          setSelectedRelayId(serverNodes[0]?.id ?? 'default');
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Channel/User state ─────────────────────────────────────
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [configChannelId, setConfigChannelId] = useState<string | null>(null);
  const [qrTarget, setQrTarget] = useState<{ channelId: string; senderId: string } | null>(null);
  const [channelModalState, setChannelModalState] = useState<ChannelModalState>(null);
  const [userModalState, setUserModalState] = useState<UserModalState>(null);
  const [channelFormError, setChannelFormError] = useState<string | null>(null);
  const [userFormError, setUserFormError] = useState<string | null>(null);
  const [isChannelSubmitting, setIsChannelSubmitting] = useState(false);
  const [isUserSubmitting, setIsUserSubmitting] = useState(false);
  const [appDialogState, setAppDialogState] = useState<AppDialogState>(null);
  const [appDialogError, setAppDialogError] = useState<string | null>(null);
  const [isAppDialogSubmitting, setIsAppDialogSubmitting] = useState(false);

  // Toast
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: 'success' | 'error' }>>([]);
  const addToast = (message: string, type: 'success' | 'error' = 'success') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  };
  const removeToast = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const [channelSubmitSuccess, setChannelSubmitSuccess] = useState(false);
  const [userSubmitSuccess, setUserSubmitSuccess] = useState(false);
  const [highlightChannelId, setHighlightChannelId] = useState<string | null>(null);
  const [highlightUserId, setHighlightUserId] = useState<string | null>(null);
  const [isDiagOpen, setIsDiagOpen] = useState(false);
  const [isDiagLoading, setIsDiagLoading] = useState(false);
  const [diagLines, setDiagLines] = useState<string[]>([]);

  const selectedChannel = relayState?.channels.find((c) => c.channelId === selectedChannelId) ?? null;
  const configChannel = relayState?.channels.find((c) => c.channelId === configChannelId) ?? null;
  const qrChannel = relayState?.channels.find((c) => c.channelId === qrTarget?.channelId) ?? null;
  const qrUser = qrChannel?.users.find((u) => u.senderId === qrTarget?.senderId) ?? null;

  // ── Dialog helpers ─────────────────────────────────────────
  const openConfirmDialog = (config: AppDialogConfig) => {
    setAppDialogError(null);
    setAppDialogState({ mode: 'confirm', ...config });
  };

  const closeAppDialog = () => {
    if (isAppDialogSubmitting) return;
    setAppDialogError(null);
    setAppDialogState(null);
  };

  const handleAppDialogConfirm = async () => {
    if (!appDialogState?.onConfirm) { setAppDialogState(null); return; }
    setIsAppDialogSubmitting(true);
    setAppDialogError(null);
    try {
      await appDialogState.onConfirm();
      // Brief pause so user sees the action completed before dialog disappears
      await new Promise((r) => setTimeout(r, 300));
      setAppDialogState(null);
    } catch (e) {
      setAppDialogError(e instanceof Error ? e.message : 'action failed');
    } finally {
      setIsAppDialogSubmitting(false);
    }
  };

  // ── Refresh ────────────────────────────────────────────────
  const refreshState = async (options?: { silent?: boolean }) => {
    if (!options?.silent) setIsRefreshing(true);
    try {
      const nextState = await apiFetch<RelayState>('/api/state', activeRelay, undefined);
      setRelayState(nextState);
      setDashboardError(null);
      return nextState;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'request failed';
      if (!options?.silent) setDashboardError(msg);
      return null;
    } finally {
      if (!options?.silent) setIsRefreshing(false);
    }
  };

  useEffect(() => { void refreshState(); }, [selectedRelayId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = window.setInterval(() => { void refreshState({ silent: true }); }, REFRESH_INTERVAL);
    return () => window.clearInterval(id);
  }, [selectedRelayId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select first channel only when current selection is invalid
  useEffect(() => {
    const channels = relayState?.channels ?? [];
    if (channels.length === 0) { setSelectedChannelId(null); return; }
    // Only auto-select if nothing selected or selected channel no longer exists
    if (!selectedChannelId || !channels.some((c) => c.channelId === selectedChannelId)) {
      setSelectedChannelId(channels[0].channelId);
    }
  }, [relayState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Message Log auto-refresh ──────────────────────────────
  useEffect(() => {
    if (!messageLogAutoRefresh || currentView !== 'messages') return;
    const id = window.setInterval(() => { void fetchMessageLog(); }, 10_000);
    return () => window.clearInterval(id);
  }, [messageLogAutoRefresh, currentView, fetchMessageLog]);

  // Refetch when page/direction/channel changes
  useEffect(() => {
    if (currentView === 'messages') { void fetchMessageLog(); void fetchMessageStats(); }
  }, [messageLogPage, messageLogDirection, messageLogChannel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Diagnostic ─────────────────────────────────────────────
  const runDiagnostic = async () => {
    setIsDiagOpen(true); setIsDiagLoading(true); setDiagLines([]);
    try {
      const s = await apiFetch<RelayState>('/api/state', activeRelay, undefined);
      setRelayState(s);
      setDiagLines(buildDiagnosticLines(s));
    } catch (e) {
      setDiagLines([`ERR: ${(e instanceof Error ? e.message : 'request failed').toUpperCase().replace(/\s+/g, '_')}`]);
    } finally { setIsDiagLoading(false); }
  };

  // ── Channel CRUD ───────────────────────────────────────────
  const submitChannel = async (values: ChannelFormValues) => {
    setIsChannelSubmitting(true); setChannelFormError(null); setChannelSubmitSuccess(false);
    const isEdit = channelModalState?.mode === 'edit';
    const trimmedId = values.channelId.trim();
    try {
      await apiFetch('/api/channels', activeRelay, {
        method: 'POST',
        body: JSON.stringify({ channelId: trimmedId, label: values.label.trim() || undefined, secret: values.secret.trim() || undefined }),
      });
      // Close modal immediately
      setChannelModalState(null); setChannelSubmitSuccess(false); setIsChannelSubmitting(false);
      addToast(isEdit ? 'Channel updated' : 'Channel created');
      // Select and highlight the channel
      setSelectedChannelId(trimmedId);
      setHighlightChannelId(trimmedId);
      setTimeout(() => setHighlightChannelId(null), 2500);
      // Refresh data
      await refreshState({ silent: true });
    } catch (e) {
      setChannelSubmitSuccess(false);
      const msg = e instanceof Error ? e.message : 'Failed to save channel';
      setChannelFormError(msg);
      addToast(msg, 'error');
      setIsChannelSubmitting(false);
    }
  };

  const submitUser = async (values: UserFormValues) => {
    if (!selectedChannel) return;
    setIsUserSubmitting(true); setUserFormError(null); setUserSubmitSuccess(false);
    const isEdit = userModalState?.mode === 'edit';
    const trimmedSid = values.senderId.trim();
    try {
      await apiFetch(`/api/channels/${encodeURIComponent(selectedChannel.channelId)}/users`, activeRelay, {
        method: 'POST',
        body: JSON.stringify({
          senderId: trimmedSid,
          chatId: values.chatId.trim() || undefined,
          token: values.token.trim() || undefined,
          allowAgents: values.allowAgents.trim() ? values.allowAgents.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          enabled: values.enabled,
        }),
      });
      // Close modal immediately
      setUserModalState(null); setUserSubmitSuccess(false); setIsUserSubmitting(false);
      addToast(isEdit ? 'User updated' : 'User added');
      setHighlightUserId(trimmedSid);
      setTimeout(() => setHighlightUserId(null), 2500);
      // Refresh data
      await refreshState({ silent: true });
    } catch (e) {
      setUserSubmitSuccess(false);
      const msg = e instanceof Error ? e.message : 'Failed to save user';
      setUserFormError(msg);
      addToast(msg, 'error');
      setIsUserSubmitting(false);
    }
  };

  const deleteChannel = async (channel: RelayChannel) => {
    await apiFetch(`/api/channels/${encodeURIComponent(channel.channelId)}`, activeRelay, { method: 'DELETE' });
    if (selectedChannelId === channel.channelId) setSelectedChannelId(null);
    void refreshState({ silent: true });
    addToast('Channel deleted');
  };

  const deleteUser = async (channel: RelayChannel, user: RelayUser) => {
    await apiFetch(`/api/channels/${encodeURIComponent(channel.channelId)}/users/${encodeURIComponent(user.senderId)}`, activeRelay, { method: 'DELETE' });
    void refreshState({ silent: true });
    addToast('User removed');
  };

  const handleDeleteChannel = (channel: RelayChannel) => {
    openConfirmDialog({
      title: 'DELETE_CHANNEL',
      message: `Delete channel "${channel.channelId}"?`,
      detail: 'This will disconnect any active backend/client sessions.',
      confirmLabel: 'DELETE',
      cancelLabel: 'KEEP',
      accent: 'rose',
      onConfirm: () => deleteChannel(channel),
    });
  };

  const handleDeleteUser = (user: RelayUser) => {
    if (!selectedChannel) return;
    openConfirmDialog({
      title: 'DELETE_USER',
      message: `Delete user "${user.senderId}" from "${selectedChannel.channelId}"?`,
      detail: 'Connection parameters will stop working immediately.',
      confirmLabel: 'DELETE',
      cancelLabel: 'KEEP',
      accent: 'rose',
      onConfirm: () => deleteUser(selectedChannel, user),
    });
  };

  const gatewayEndpoint = activeRelay.url || buildGatewayEndpoint(relayState);
  const backendEndpoint = `${httpToWs(activeRelay.url || normalizeBaseUrl(relayState?.publicBaseUrl) || window.location.origin)}/backend`;
  const gatewayStatus = relayState && relayState.channels.length > 0 && relayState.stats.backendCount === 0 ? 'DEGRADED' : 'RUNNING';

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1d1d1f] flex flex-col selection:bg-[#0071e3]/15">

      {/* ── Header (Apple glass nav) ── */}
      <header className="sticky top-0 z-50 h-12 bg-black/80 backdrop-blur-[20px] backdrop-saturate-[180%] px-5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex items-center gap-2 text-white shrink-0">
            <Hexagon className="w-4 h-4" strokeWidth={1} />
            <span className="text-sm font-semibold tracking-tight hidden sm:inline">{GATEWAY_NAME}</span>
          </div>
          <StatusDot active={!!relayState} />
          {/* Relay selector */}
          <div className="flex items-center gap-2 min-w-0">
            <select value={selectedRelayId}
              onChange={(e) => { setSelectedRelayId(e.target.value); setRelayState(null); }}
              className="bg-white/10 border border-white/20 text-white text-xs px-2.5 py-1 rounded-lg focus:outline-none focus:border-white/40 cursor-pointer min-w-0">
              {relayNodes.map((n) => <option key={n.id} value={n.id} className="bg-black text-white">{n.name}</option>)}
            </select>
            <button type="button" onClick={() => { setIsRelaySettingsOpen(true); void fetchCorsOrigins(); }}
              className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/70 hover:bg-white/20 hover:text-white transition-colors" title="Settings">
              <Settings className="w-3.5 h-3.5" strokeWidth={1.8} />
            </button>
            <button type="button" onClick={() => { setIsAiSettingsOpen(true); void fetchAiSettings(); }}
              className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/70 hover:bg-white/20 hover:text-white transition-colors" title="AI Settings">
              <Sparkles className="w-3.5 h-3.5" strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={() => void refreshState()} disabled={isRefreshing}
            className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/70 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40" title="Refresh">
            <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
          </button>
          {logtoUser && (
            <span className="text-white/50 text-xs items-center gap-1.5 hidden md:flex" title={logtoUser.sub}>
              <span className="truncate max-w-[80px]">{logtoUser.name ?? logtoUser.username ?? logtoUser.email ?? logtoUser.sub}</span>
            </span>
          )}
          <button type="button" onClick={onLogtoSignOut}
            style={{ borderRadius: '980px' }}
            className="px-3 py-1 border border-white/20 text-white/70 hover:text-white hover:border-white/40 transition-colors text-xs">
            Sign out
          </button>
        </div>
      </header>

      {/* ── Relay Settings Modal ── */}
      {isRelaySettingsOpen && (
        <ModalShell title="RELAY_NODES" icon={Server} onClose={() => { setIsRelaySettingsOpen(false); setEditingRelay(null); }}>
          {editingRelay ? (
            <form onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const updated: RelayNode = {
                id: editingRelay.id || (fd.get('name') as string).toLowerCase().replace(/[^a-z0-9-]/g, '-') || randomToken().slice(0, 8),
                name: (fd.get('name') as string).trim(),
                url: (fd.get('url') as string).trim().replace(/\/+$/, ''),
                adminToken: (fd.get('adminToken') as string).trim(),
              };
              if (!updated.name || !updated.url) return;
              await saveRelayNodeToServer(updated, gatewayRelay);
              const existing = relayNodes.findIndex((n) => n.id === editingRelay.id);
              const next = existing >= 0 ? relayNodes.map((n) => n.id === editingRelay.id ? updated : n) : [...relayNodes, updated];
              await updateRelayNodes(next);
              setSelectedRelayId(updated.id);
              setEditingRelay(null);
              setRelayState(null);
            }} className="p-6 space-y-5">
              <div className="space-y-2">
                <label className={labelClassName}>Name</label>
                <input name="name" defaultValue={editingRelay.name} className={inputClassName} required />
              </div>
              <div className="space-y-2">
                <label className={labelClassName}>URL</label>
                <input name="url" defaultValue={editingRelay.url} placeholder="https://relay.example.com" className={inputClassName} required />
              </div>
              <div className="space-y-2">
                <label className={labelClassName}>Admin Token</label>
                <input name="adminToken" type="password" defaultValue={editingRelay.adminToken} className={inputClassName} />
              </div>
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setEditingRelay(null)} className="px-5 py-2 rounded-lg text-sm text-white/70 bg-white/10 hover:bg-white/15 transition-colors">Cancel</button>
                <button type="submit" className="px-5 py-2 rounded-lg text-sm font-medium bg-[#0071e3] text-white hover:bg-[#0077ed] transition-colors">Save</button>
              </div>
            </form>
          ) : (
            <div className="p-5 space-y-3">
              {relayNodes.map((n) => (
                <div key={n.id} className={cn('rounded-xl px-4 py-3 flex items-center justify-between gap-4',
                  n.id === selectedRelayId ? 'bg-[#0071e3]/20 ring-1 ring-[#0071e3]/40' : 'bg-white/5')}>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white font-medium truncate">{n.name}</div>
                    <div className="text-xs text-white/40 truncate mt-0.5">{n.url}</div>
                    <div className="text-xs text-white/25 mt-0.5">{n.adminToken ? '••••••••' : 'No token'}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => setEditingRelay(n)} className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/20 transition-colors">
                      <Pencil className="w-3 h-3" />
                    </button>
                    {relayNodes.length > 1 && (
                      <button onClick={async () => {
                        await deleteRelayNodeFromServer(n.id, gatewayRelay);
                        const next = relayNodes.filter((x) => x.id !== n.id);
                        await updateRelayNodes(next);
                        if (selectedRelayId === n.id) { setSelectedRelayId(next[0].id); setRelayState(null); }
                      }} className="w-7 h-7 rounded-full bg-red-500/10 flex items-center justify-center text-red-400 hover:bg-red-500/20 transition-colors">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button onClick={() => setEditingRelay({ id: '', name: '', url: '', adminToken: '' })}
                className="w-full py-3 rounded-xl border border-dashed border-white/20 text-white/40 text-sm hover:text-white/70 hover:border-white/40 transition-all flex items-center justify-center gap-2">
                <Plus className="w-4 h-4" /> Add Relay Node
              </button>
              <div className="pt-4 border-t border-white/10 mt-2">
                <h3 className="text-xs font-semibold text-white/40 tracking-widest uppercase mb-3">CORS Allowed Origins</h3>
                <div className="space-y-2 mb-3">
                  {corsOrigins.length === 0 && <p className="text-sm text-white/30">No origins configured (same-origin only)</p>}
                  {corsOrigins.map((origin, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                      <span className="flex-1 text-sm text-white/70 truncate">{origin}</span>
                      <button type="button" onClick={() => { const next = corsOrigins.filter((_, j) => j !== i); void saveCorsOrigins(next); }}
                        className="text-white/30 hover:text-red-400 transition-colors">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <form onSubmit={(e) => { e.preventDefault(); const v = corsInput.trim(); if (v && !corsOrigins.includes(v)) { void saveCorsOrigins([...corsOrigins, v]); setCorsInput(''); } }}
                  className="flex gap-2">
                  <input value={corsInput} onChange={e => setCorsInput(e.target.value)}
                    placeholder="http://localhost:4026"
                    className={inputClassName + ' flex-1'} />
                  <button type="submit" disabled={corsSaving || !corsInput.trim()}
                    className="px-4 py-2 rounded-[11px] bg-[#0071e3] text-white text-sm disabled:opacity-30 transition-colors shrink-0 flex items-center">
                    {corsSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  </button>
                </form>
              </div>
              <div className="pt-4 border-t border-white/10">
                <button type="button" onClick={() => { void runDiagnostic(); setIsRelaySettingsOpen(false); }}
                  className="w-full py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors flex items-center justify-center gap-2 text-sm">
                  <Activity className="w-4 h-4" /> Run Diagnostic
                </button>
              </div>
            </div>
          )}
        </ModalShell>
      )}

      {/* ── AI Settings Modal ── */}
      {isAiSettingsOpen && (
        <ModalShell title="AI Settings" icon={Sparkles} onClose={() => setIsAiSettingsOpen(false)} maxWidth="max-w-xl">
          {/* Tab bar */}
          <div className="flex border-b border-white/10 px-5 -mx-0">
            {([['provider', 'Provider', Globe], ['suggestions', 'Suggestions', Sparkles], ['reply', 'Reply Draft', MessageSquare], ['voice', 'Voice', Mic]] as const).map(([key, label, TabIcon]) => (
              <button key={key} type="button" onClick={() => setAiSettingsTab(key)}
                className={cn('flex items-center gap-1.5 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px',
                  aiSettingsTab === key ? 'border-[#0071e3] text-[#2997ff]' : 'border-transparent text-white/40 hover:text-white/70')}>
                <TabIcon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          <div className="p-6">
          {/* Provider tab */}
          {aiSettingsTab === 'provider' && (
            <div className="space-y-5">
              <p className="text-sm text-white/40 leading-relaxed">Override the default Azure OpenAI config. Leave empty to use hardcoded defaults (gpt-5.4-mini).</p>
              <div className="space-y-2">
                <label className={labelClassName}>Endpoint</label>
                <input className={inputClassName} value={aiSettings.llmEndpoint}
                  onChange={e => setAiSettings(s => ({ ...s, llmEndpoint: e.target.value }))}
                  placeholder="https://resley-east-us-2-resource.openai.azure.com/openai/v1" />
              </div>
              <div className="space-y-2">
                <label className={labelClassName}>API Key</label>
                <input className={inputClassName} type="password" value={aiSettings.llmApiKey}
                  onChange={e => setAiSettings(s => ({ ...s, llmApiKey: e.target.value }))}
                  placeholder="Already configured — enter new key to change" />
              </div>
              <div className="space-y-2">
                <label className={labelClassName}>Default Model</label>
                <select className={inputClassName} value={aiSettings.llmModel}
                  onChange={e => setAiSettings(s => ({ ...s, llmModel: e.target.value }))}>
                  <option value="">gpt-5.4-mini (default)</option>
                  {['gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-image-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'MiniMax-M2.5', 'FW-GLM-5', 'Kimi-K2.5'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <p className="text-xs text-white/25">Used when no per-feature model is set.</p>
              </div>
            </div>
          )}

          {/* Suggestions tab */}
          {aiSettingsTab === 'suggestions' && (
            <div className="space-y-5">
              <div className="space-y-2">
                <label className={labelClassName}>Model</label>
                <select className={inputClassName} value={aiSettings.suggestionModel}
                  onChange={e => setAiSettings(s => ({ ...s, suggestionModel: e.target.value }))}>
                  <option value="">(default: {aiSettings.llmModel || 'gpt-5.4-mini'})</option>
                  {['gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-image-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'MiniMax-M2.5', 'FW-GLM-5', 'Kimi-K2.5'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className={labelClassName}>System Prompt</label>
                <textarea className={inputClassName + ' min-h-[120px] resize-y'} value={aiSettings.suggestionPrompt}
                  onChange={e => setAiSettings(s => ({ ...s, suggestionPrompt: e.target.value }))}
                  placeholder="Leave empty for built-in prompt. User custom prompts are appended to this." />
              </div>
            </div>
          )}

          {/* Reply Draft tab */}
          {aiSettingsTab === 'reply' && (
            <div className="space-y-5">
              <div className="space-y-2">
                <label className={labelClassName}>Model</label>
                <select className={inputClassName} value={aiSettings.replyModel}
                  onChange={e => setAiSettings(s => ({ ...s, replyModel: e.target.value }))}>
                  <option value="">(default: {aiSettings.llmModel || 'gpt-5.4-mini'})</option>
                  {['gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'MiniMax-M2.5', 'FW-GLM-5', 'Kimi-K2.5'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className={labelClassName}>System Prompt</label>
                <textarea className={inputClassName + ' min-h-[120px] resize-y'} value={aiSettings.replyPrompt || ''}
                  onChange={e => setAiSettings(s => ({ ...s, replyPrompt: e.target.value }))}
                  placeholder="Leave empty for built-in prompt. Controls how AI drafts replies from user's perspective." />
                <p className="text-xs text-white/25">Default: "You are a reply drafting assistant..." — override to change tone or behavior.</p>
              </div>
            </div>
          )}

          {/* Voice tab */}
          {aiSettingsTab === 'voice' && (
            <div className="space-y-5">
              <div className="space-y-2">
                <label className={labelClassName}>Model</label>
                <select className={inputClassName} value={aiSettings.voiceRefineModel}
                  onChange={e => setAiSettings(s => ({ ...s, voiceRefineModel: e.target.value }))}>
                  <option value="">(default: {aiSettings.llmModel || 'gpt-5.4-mini'})</option>
                  {['gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-image-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'MiniMax-M2.5', 'FW-GLM-5', 'Kimi-K2.5'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className={labelClassName}>System Prompt</label>
                <textarea className={inputClassName + ' min-h-[120px] resize-y'} value={aiSettings.voiceRefinePrompt}
                  onChange={e => setAiSettings(s => ({ ...s, voiceRefinePrompt: e.target.value }))}
                  placeholder="Leave empty for built-in prompt." />
              </div>
            </div>
          )}

          {/* Save button */}
          <div className="mt-6 pt-5 border-t border-white/10">
            <button type="button" onClick={() => void saveAiSettingsHandler()} disabled={aiSettingsSaving}
              className="w-full py-3 rounded-xl bg-[#0071e3] text-white text-sm font-medium hover:bg-[#0077ed] transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
              {aiSettingsSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Save Settings
            </button>
          </div>
          </div>
        </ModalShell>
      )}

      <DiagnosticModal isOpen={isDiagOpen} isLoading={isDiagLoading} lines={diagLines} onClose={() => setIsDiagOpen(false)} />
      <AppDialogModal state={appDialogState} isSubmitting={isAppDialogSubmitting} error={appDialogError} onClose={closeAppDialog} onConfirm={() => { void handleAppDialogConfirm(); }} />
      <NodeConfigModal channel={configChannel} backendEndpoint={backendEndpoint} onClose={() => setConfigChannelId(null)} />
      <UserConnectModal user={qrUser} channel={qrChannel} relayState={relayState} onClose={() => setQrTarget(null)} />
      <ChannelFormModal state={channelModalState} onClose={() => { if (!isChannelSubmitting && !channelSubmitSuccess) { setChannelModalState(null); setChannelFormError(null); } }} onSubmit={submitChannel} isSubmitting={isChannelSubmitting} submitSuccess={channelSubmitSuccess} error={channelFormError} />
      <UserFormModal state={userModalState} channel={selectedChannel} onClose={() => { if (!isUserSubmitting && !userSubmitSuccess) { setUserModalState(null); setUserFormError(null); } }} onSubmit={submitUser} isSubmitting={isUserSubmitting} submitSuccess={userSubmitSuccess} error={userFormError} />

      {/* Toasts */}
      <div role="status" aria-live="polite" className="fixed bottom-5 right-5 z-[200] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className={cn(
            'pointer-events-auto px-4 py-3 text-sm rounded-xl shadow-lg animate-[fadeSlideIn_0.3s_ease-out] flex items-center gap-3',
            t.type === 'success' ? 'bg-[#1c1c1e] text-white border border-white/10' : 'bg-red-950 text-red-200 border border-red-500/20',
          )}>
            {t.type === 'success' ? <Check className="w-4 h-4 text-emerald-400 shrink-0" /> : <CircleAlert className="w-4 h-4 text-red-400 shrink-0" />}
            <span>{t.message}</span>
            <button onClick={() => removeToast(t.id)} className="ml-1 text-white/30 hover:text-white/70 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* ── Main Content ── */}
      <main className="flex-1 p-5 lg:p-8 flex flex-col gap-6 max-w-[1280px] mx-auto w-full">
        {dashboardError && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-5 py-4 text-sm text-red-700">{dashboardError}</div>
        )}

        {/* ── View Toggle Nav ── */}
        <div className="flex items-center gap-1 shrink-0 border-b border-black/[0.08]">
          <button type="button" onClick={() => setCurrentView('dashboard')}
            className={cn('px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px',
              currentView === 'dashboard' ? 'border-[#0071e3] text-[#0071e3]' : 'border-transparent text-black/48 hover:text-[#1d1d1f]')}>
            <div className="flex items-center gap-2"><Server className="w-4 h-4" /> Dashboard</div>
          </button>
          <button type="button" onClick={() => { setCurrentView('messages'); void fetchMessageLog(); void fetchMessageStats(); }}
            className={cn('px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px',
              currentView === 'messages' ? 'border-[#0071e3] text-[#0071e3]' : 'border-transparent text-black/48 hover:text-[#1d1d1f]')}>
            <div className="flex items-center gap-2"><MessageSquare className="w-4 h-4" /> Messages</div>
          </button>
        </div>

        {currentView === 'dashboard' && (<>
        {/* Overview Stats */}
        <div className="grid grid-cols-3 gap-4 shrink-0">
          {[
            { label: 'Channels', value: relayState?.channels.length ?? 0, icon: Network },
            { label: 'Backends', value: relayState?.stats.backendCount ?? 0, icon: Server },
            { label: 'Clients', value: relayState?.stats.clientCount ?? 0, icon: Users },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="bg-white rounded-xl p-5 shadow-[rgba(0,0,0,0.08)_0px_2px_16px_0px]">
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4 text-[#0071e3]" strokeWidth={1.5} />
                <span className="text-xs font-semibold text-black/48 tracking-wide uppercase">{label}</span>
              </div>
              <div className="flex items-end justify-between">
                <span style={{ fontSize: '40px', fontWeight: 600, lineHeight: 1.07, letterSpacing: '-0.28px' }} className="text-[#1d1d1f]">{value}</span>
                <StatusDot active={value > 0} />
              </div>
            </div>
          ))}
        </div>

        {/* Channels + Users */}
        <div className="flex-1 flex flex-col lg:flex-row gap-5 min-h-0">
          {/* Channel List */}
          <Panel title="Channels" icon={Network} className="w-full lg:w-[300px] xl:w-[340px] shrink-0 flex flex-col">
            <div className="flex-1 overflow-y-auto -mx-4 px-4 space-y-2">
              {relayState?.channels.length ? relayState.channels.map((ch) => (
                <div key={ch.channelId} onClick={() => setSelectedChannelId(ch.channelId)}
                  className={cn('rounded-xl px-4 py-3 transition-all cursor-pointer group relative',
                    highlightChannelId === ch.channelId ? 'bg-[#0071e3]/10 ring-1 ring-[#0071e3]/30 animate-[highlightPulse_1s_ease-in-out_2]' :
                    selectedChannelId === ch.channelId ? 'bg-[#0071e3]/8 ring-1 ring-[#0071e3]/20' : 'bg-[#f5f5f7] hover:bg-black/[0.04]')}>
                  <div className="flex justify-between items-start gap-2 mb-2">
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold text-[#1d1d1f] truncate leading-tight">{ch.label || ch.channelId}</div>
                      {ch.label && <div className="text-xs text-black/30 mt-0.5 truncate">{ch.channelId}</div>}
                    </div>
                    <StatusDot active={ch.backendConnected} />
                  </div>
                  <div className="flex items-center gap-4 text-xs text-black/48 mb-2.5">
                    <span><span className="text-[#1d1d1f] font-semibold">{ch.clientCount}</span> clients</span>
                    <span><span className="text-[#1d1d1f] font-semibold">{ch.userCount}</span> users</span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={(e) => { e.stopPropagation(); setChannelModalState({ mode: 'edit', channel: ch }); setChannelFormError(null); }}
                      className="flex-1 py-1 rounded-lg text-xs text-[#0066cc] hover:underline transition-colors text-center" title="Edit">
                      Edit
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setConfigChannelId(ch.channelId); }}
                      className="flex-1 py-1 rounded-lg text-xs text-[#0066cc] hover:underline transition-colors text-center" title="Config">
                      Config
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteChannel(ch); }}
                      className="flex-1 py-1 rounded-lg text-xs text-red-500 hover:underline transition-colors text-center" title="Delete">
                      Delete
                    </button>
                  </div>
                </div>
              )) : (
                <div className="h-full flex flex-col items-center justify-center text-black/30 text-sm py-12">
                  <Database className="w-10 h-10 mb-3 opacity-30" />
                  <span>No channels yet</span>
                </div>
              )}
            </div>
            <button onClick={() => { setChannelModalState({ mode: 'create' }); setChannelFormError(null); }}
              style={{ borderRadius: '980px' }}
              className="mt-4 w-full py-2.5 bg-[#0071e3] text-white text-sm font-medium hover:bg-[#0077ed] transition-colors flex items-center justify-center gap-2">
              <Plus className="w-4 h-4" /> New Channel
            </button>
          </Panel>

          {/* User Table */}
          <Panel title={selectedChannel ? `Users — ${selectedChannel.label || selectedChannel.channelId}` : 'Users'} icon={Users} className="flex-1 flex flex-col min-w-0">
            <div className="flex-1 overflow-y-auto -mx-4 px-4">
              {!selectedChannel ? (
                <div className="h-full flex flex-col items-center justify-center text-black/30 text-sm py-12">
                  <ShieldAlert className="w-10 h-10 mb-3 opacity-30" />
                  <span>Select a channel</span>
                </div>
              ) : selectedChannel.users.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-black/30 text-sm py-12">
                  <Database className="w-10 h-10 mb-3 opacity-30" />
                  <span>No users registered</span>
                </div>
              ) : (
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">User configurations</caption>
                  <thead>
                    <tr className="text-xs font-semibold text-black/48 border-b border-black/[0.06] uppercase tracking-wide">
                      <th scope="col" className="pb-3 font-semibold pl-1">Sender</th>
                      <th scope="col" className="pb-3 font-semibold">Token</th>
                      <th scope="col" className="pb-3 font-semibold">Status</th>
                      <th scope="col" className="pb-3 font-semibold">Chat</th>
                      <th scope="col" className="pb-3 font-semibold text-right pr-1">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/[0.04]">
                    {selectedChannel.users.map((user) => (
                      <tr key={user.senderId} className={cn('hover:bg-black/[0.02] transition-colors group',
                        highlightUserId === user.senderId && 'bg-[#0071e3]/5 animate-[highlightPulse_1s_ease-in-out_2]')}>
                        <td className="py-3 pl-1">
                          <div className="flex items-center gap-2">
                            <Lock className="w-3.5 h-3.5 text-black/20" />
                            <span className="text-[#1d1d1f] font-medium">{user.senderId}</span>
                          </div>
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-black/40 text-xs">{user.token.slice(0, 8)}…{user.token.slice(-4)}</span>
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity"><CopyBtn text={user.token} /></div>
                          </div>
                        </td>
                        <td className="py-3"><StatusDot active={user.enabled} /></td>
                        <td className="py-3 text-black/48 text-sm">{user.chatId || '—'}</td>
                        <td className="py-3 pr-1 text-right">
                          <div className="inline-flex gap-1.5">
                            <button onClick={() => setQrTarget({ channelId: selectedChannel.channelId, senderId: user.senderId })}
                              className="w-7 h-7 rounded-full bg-[#0071e3]/10 flex items-center justify-center text-[#0071e3] hover:bg-[#0071e3]/20 transition-colors" title="Connect">
                              <QrCode className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => { setUserModalState({ mode: 'edit', user }); setUserFormError(null); }}
                              className="w-7 h-7 rounded-full bg-black/[0.04] flex items-center justify-center text-black/48 hover:bg-black/[0.08] hover:text-[#1d1d1f] transition-colors" title="Edit">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleDeleteUser(user)}
                              className="w-7 h-7 rounded-full bg-red-50 flex items-center justify-center text-red-400 hover:bg-red-100 transition-colors" title="Delete">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="mt-4 pt-4 border-t border-black/[0.06] flex justify-between items-center gap-4">
              <span className="text-xs text-black/30">
                Last sync: {formatTimestamp(relayState?.timestamp)}
              </span>
              <button onClick={() => { setUserModalState({ mode: 'create' }); setUserFormError(null); }}
                disabled={!selectedChannel}
                style={{ borderRadius: '980px' }}
                className="px-5 py-2 bg-[#0071e3] text-white text-sm font-medium hover:bg-[#0077ed] transition-colors flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed">
                <Plus className="w-3.5 h-3.5" /> Add User
              </button>
            </div>
          </Panel>
        </div>
        </>)}

        {currentView === 'messages' && (<>
        {/* ── Stats Bar ── */}
        {(() => {
          const inboundCount = messageLogRows.filter(m => m.direction === 'inbound').length;
          const outboundCount = messageLogRows.filter(m => m.direction === 'outbound').length;
          const uniqueChannels = new Set(messageLogRows.map(m => m.channel_id)).size;
          return (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
              {[
                { label: 'Total Messages', value: messageLogTotal },
                { label: 'Inbound', value: inboundCount },
                { label: 'Outbound', value: outboundCount },
                { label: 'Channels', value: uniqueChannels },
              ].map(stat => (
                <div key={stat.label} className="bg-white rounded-xl px-5 py-4 shadow-[rgba(0,0,0,0.08)_0px_2px_16px_0px]">
                  <div className="text-xs font-semibold text-black/48 tracking-wide uppercase mb-1">{stat.label}</div>
                  <div style={{ fontSize: '32px', fontWeight: 600, lineHeight: 1.07, letterSpacing: '-0.28px' }} className="text-[#1d1d1f]">{stat.value}</div>
                </div>
              ))}
            </div>
          );
        })()}

        {/* ── Analytics Section ── */}
        <div className="bg-white rounded-xl shadow-[rgba(0,0,0,0.08)_0px_2px_16px_0px] shrink-0 overflow-hidden">
          <button type="button" onClick={() => setMessageAnalyticsOpen(!messageAnalyticsOpen)}
            className="w-full flex items-center gap-2 px-5 py-4 border-b border-black/[0.06] hover:bg-black/[0.02] transition-colors">
            <BarChart3 className="w-4 h-4 text-[#0071e3]" strokeWidth={1.8} />
            <span className="text-sm font-semibold text-[#1d1d1f]">Analytics</span>
            <span className="flex-1" />
            {messageAnalyticsOpen ? <ChevronUp className="w-4 h-4 text-black/30" /> : <ChevronDown className="w-4 h-4 text-black/30" />}
          </button>
          {messageAnalyticsOpen && messageStats && (
            <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Messages per hour */}
              <div className="bg-[#f5f5f7] rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-black/[0.06]">
                  <BarChart3 className="w-3.5 h-3.5 text-[#0071e3]" strokeWidth={1.8} />
                  <span className="text-xs font-semibold text-black/48 tracking-wide uppercase">Messages / Hour</span>
                  <span className="flex-1" />
                  <span className="text-[10px] text-black/30">24h</span>
                </div>
                <div className="px-4 pt-4 pb-2 relative">
                  <div className="absolute inset-x-4 top-4 bottom-7 flex flex-col justify-between pointer-events-none">
                    {[0, 1, 2, 3].map(i => <div key={i} className="border-t border-black/[0.06]" />)}
                  </div>
                  <div className="flex items-end gap-[1px] h-[80px] relative">
                    {(() => {
                      const maxVal = Math.max(1, ...messageStats.hourly.map(h => h.inbound + h.outbound));
                      return messageStats.hourly.map((h, i) => {
                        const total = h.inbound + h.outbound;
                        const pct = (total / maxVal) * 100;
                        return (
                          <div key={i} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                            <div className="absolute -top-5 left-1/2 -translate-x-1/2 hidden group-hover:block bg-black/80 text-white text-[9px] px-2 py-1 rounded-md whitespace-nowrap z-10 shadow-lg">
                              {h.hour} · ↑{h.inbound} ↓{h.outbound}
                            </div>
                            {total > 0 ? (
                              <div style={{ height: `${Math.max(pct, 2)}%` }} className="w-full flex flex-col justify-end overflow-hidden rounded-t-sm">
                                {h.outbound > 0 && <div style={{ flex: h.outbound }} className="bg-[#0071e3]/40 group-hover:bg-[#0071e3]/60 transition-colors min-h-[1px]" />}
                                {h.inbound > 0 && <div style={{ flex: h.inbound }} className="bg-[#0071e3]/70 group-hover:bg-[#0071e3] transition-colors min-h-[1px]" />}
                              </div>
                            ) : (
                              <div className="w-full h-[1px] bg-black/10" />
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>
                  <div className="flex mt-2">
                    {messageStats.hourly.map((h, i) => (
                      <div key={i} className="flex-1 text-center">
                        {i % 4 === 0 && <span className="text-[8px] text-black/30">{h.hour}</span>}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="px-4 pb-3 flex gap-4 text-[10px] text-black/40">
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 bg-[#0071e3]/70 rounded-sm" /> Inbound</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 bg-[#0071e3]/40 rounded-sm" /> Outbound</span>
                </div>
              </div>

              {/* Model usage */}
              <div className="bg-[#f5f5f7] rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-black/[0.06]">
                  <Activity className="w-3.5 h-3.5 text-[#0071e3]" strokeWidth={1.8} />
                  <span className="text-xs font-semibold text-black/48 tracking-wide uppercase">Model Usage</span>
                </div>
                <div className="px-4 py-3 space-y-3 max-h-[160px] overflow-y-auto">
                  {messageStats.models.length === 0 && <div className="text-black/30 text-xs py-4 text-center">No model data</div>}
                  {(() => {
                    const maxCount = Math.max(1, ...messageStats.models.map(m => m.count));
                    return messageStats.models.map((m) => (
                      <div key={m.name}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-[#1d1d1f] truncate" title={m.name}>{m.name.split('/').pop()}</span>
                          <span className="text-xs text-black/40 tabular-nums ml-2">{m.count}</span>
                        </div>
                        <div className="bg-black/[0.06] h-1.5 rounded-full overflow-hidden">
                          <div className="h-full bg-[#0071e3] rounded-full transition-all"
                            style={{ width: `${(m.count / maxCount) * 100}%` }} />
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>

              {/* Channel activity */}
              <div className="bg-[#f5f5f7] rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-black/[0.06]">
                  <Network className="w-3.5 h-3.5 text-[#0071e3]" strokeWidth={1.8} />
                  <span className="text-xs font-semibold text-black/48 tracking-wide uppercase">Channel Activity</span>
                </div>
                <div className="px-4 py-3 space-y-3 max-h-[160px] overflow-y-auto">
                  {messageStats.channels.length === 0 && <div className="text-black/30 text-xs py-4 text-center">No data</div>}
                  {(() => {
                    const maxCount = Math.max(1, ...messageStats.channels.map(c => c.inbound + c.outbound));
                    return messageStats.channels.map(c => (
                      <div key={c.name}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-[#0066cc] truncate">{c.name}</span>
                          <span className="text-xs text-black/40 tabular-nums ml-2">{c.inbound}/{c.outbound}</span>
                        </div>
                        <div className="bg-black/[0.06] h-1.5 rounded-full overflow-hidden flex">
                          {c.inbound > 0 && <div className="h-full bg-[#0071e3]" style={{ width: `${(c.inbound / maxCount) * 100}%` }} />}
                          {c.outbound > 0 && <div className="h-full bg-[#0071e3]/40" style={{ width: `${(c.outbound / maxCount) * 100}%` }} />}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>
          )}
          {messageAnalyticsOpen && !messageStats && (
            <div className="p-8 flex items-center justify-center text-black/30 text-sm gap-3">
              <RefreshCw className="w-4 h-4 animate-spin" /> Loading analytics…
            </div>
          )}
        </div>

        {/* ── Filter Bar ── */}
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <select value={messageLogChannel}
            onChange={e => { setMessageLogChannel(e.target.value); setMessageLogPage(0); }}
            className="bg-[#fafafc] border-[3px] border-black/[0.04] rounded-[11px] text-[#1d1d1f] text-sm px-3 py-2 focus:outline-none focus:border-[#0071e3] transition-colors">
            <option value="">All Channels</option>
            {relayState?.channels?.map(ch => (
              <option key={ch.channelId} value={ch.channelId}>{ch.label || ch.channelId}</option>
            ))}
          </select>
          <select value={messageLogDirection}
            onChange={e => { setMessageLogDirection(e.target.value as '' | 'inbound' | 'outbound'); setMessageLogPage(0); }}
            className="bg-[#fafafc] border-[3px] border-black/[0.04] rounded-[11px] text-[#1d1d1f] text-sm px-3 py-2 focus:outline-none focus:border-[#0071e3] transition-colors">
            <option value="">All Directions</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
          <button type="button" onClick={() => void fetchMessageLog()} disabled={messageLogLoading}
            className="w-9 h-9 rounded-full bg-[#0071e3]/10 flex items-center justify-center text-[#0071e3] hover:bg-[#0071e3]/20 transition-colors disabled:opacity-40">
            <RefreshCw className={cn('w-4 h-4', messageLogLoading && 'animate-spin')} />
          </button>
          <label className="flex items-center gap-2 text-sm text-black/48 cursor-pointer select-none">
            <input type="checkbox" checked={messageLogAutoRefresh} onChange={e => setMessageLogAutoRefresh(e.target.checked)}
              className="accent-[#0071e3]" />
            Auto-refresh
            {messageLogAutoRefresh && <span className="text-[#0071e3] text-xs">(10s)</span>}
          </label>
          <span className="flex-1" />
          <span className="text-sm text-black/30 tabular-nums">{messageLogTotal} messages</span>
        </div>

        {/* ── Message Table ── */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 overflow-y-auto bg-white rounded-xl shadow-[rgba(0,0,0,0.08)_0px_2px_16px_0px]">
            {messageLogRows.length === 0 && !messageLogLoading && (
              <div className="py-16 text-center text-black/30 text-sm">No messages found</div>
            )}
            {messageLogLoading && messageLogRows.length === 0 && (
              <div className="py-16 text-center text-black/30 text-sm flex items-center justify-center gap-3">
                <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white/90 backdrop-blur-sm z-10">
                <tr className="text-black/48 text-left border-b border-black/[0.06]">
                  <th className="px-5 py-3 text-xs font-semibold tracking-wide uppercase">Time</th>
                  <th className="px-5 py-3 text-xs font-semibold tracking-wide uppercase">Channel</th>
                  <th className="px-5 py-3 text-xs font-semibold tracking-wide uppercase">Direction</th>
                  <th className="px-5 py-3 text-xs font-semibold tracking-wide uppercase">Sender</th>
                  <th className="px-5 py-3 text-xs font-semibold tracking-wide uppercase">Agent</th>
                  <th className="px-5 py-3 text-xs font-semibold tracking-wide uppercase">Content</th>
                </tr>
              </thead>
              <tbody>
                {messageLogRows.map(msg => {
                  const isExpanded = expandedMessageId === msg.id;
                  return (
                    <tr key={msg.id} onClick={() => setExpandedMessageId(isExpanded ? null : msg.id)}
                      className={cn('border-t border-black/[0.04] hover:bg-black/[0.02] transition-colors cursor-pointer',
                        isExpanded && 'bg-[#0071e3]/[0.02]')}>
                      <td className="px-5 py-3 text-black/40 whitespace-nowrap tabular-nums align-top w-[100px] text-xs"
                        title={new Date(msg.timestamp).toLocaleString()}>
                        {relativeTime(msg.timestamp)}
                      </td>
                      <td className="px-5 py-3 text-[#0066cc] align-top w-[80px] text-xs">{msg.channel_id}</td>
                      <td className="px-5 py-3 align-top whitespace-nowrap w-[70px]">
                        <span className={cn('inline-flex items-center gap-1.5 text-xs',
                          msg.direction === 'inbound' ? 'text-[#0071e3]' : 'text-emerald-600')}>
                          <span className={cn('w-1.5 h-1.5 rounded-full',
                            msg.direction === 'inbound' ? 'bg-[#0071e3]' : 'bg-emerald-500')} />
                          {msg.direction === 'inbound' ? '↑ In' : '↓ Out'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-black/48 align-top w-[90px] text-xs">{msg.sender_id || '—'}</td>
                      <td className="px-5 py-3 text-purple-600/70 align-top w-[90px] text-xs">{msg.agent_id || '—'}</td>
                      <td className="px-5 py-3 text-[#1d1d1f] align-top">
                        {isExpanded ? (
                          <pre className="whitespace-pre-wrap break-all text-xs text-[#1d1d1f] max-h-60 overflow-y-auto">{msg.content || '—'}</pre>
                        ) : (
                          <span className="truncate block text-sm" title={msg.content || ''}>{msg.content?.slice(0, 200) || '—'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Pagination ── */}
          <div className="flex items-center justify-between pt-4 shrink-0">
            <button type="button" onClick={() => setMessageLogPage(p => Math.max(0, p - 1))} disabled={messageLogPage === 0 || messageLogLoading}
              style={{ borderRadius: '980px' }}
              className="px-4 py-2 border border-black/[0.12] text-[#1d1d1f] hover:bg-black/[0.04] transition-colors text-sm flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed">
              <ChevronLeft className="w-4 h-4" /> Previous
            </button>
            <span className="text-xs text-black/40 tabular-nums">
              {messageLogPage + 1} of {Math.max(1, Math.ceil(messageLogTotal / MESSAGE_PAGE_SIZE))}
            </span>
            <button type="button" onClick={() => setMessageLogPage(p => p + 1)} disabled={(messageLogPage + 1) * MESSAGE_PAGE_SIZE >= messageLogTotal || messageLogLoading}
              style={{ borderRadius: '980px' }}
              className="px-4 py-2 border border-black/[0.12] text-[#1d1d1f] hover:bg-black/[0.04] transition-colors text-sm flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed">
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
        </>)}
      </main>
    </div>
  );
}

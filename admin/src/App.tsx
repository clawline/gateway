import { useEffect, useState, useCallback, type FormEvent, type ReactNode } from 'react';
import { useLogto, type IdTokenClaims } from '@logto/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  Activity,
  Check,
  ChevronRight,
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
  const serverUrl = `${wsBase}/client?channelId=${encodeURIComponent(channel.channelId)}&token=${encodeURIComponent(user.token)}${user.chatId ? `&chatId=${encodeURIComponent(user.chatId)}` : ''}`;
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
  'w-full bg-slate-900/60 border border-slate-700 p-3 text-slate-200 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition-all font-mono text-sm placeholder:text-slate-600';

const labelClassName = 'text-[11px] font-medium text-slate-400 tracking-widest uppercase';

const CopyBtn = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button type="button" onClick={handleCopy} className="text-slate-500 hover:text-cyan-400 transition-colors">
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
  <div className={cn('bg-slate-900/50 border border-slate-800 flex flex-col overflow-hidden', className)}>
    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-800 bg-slate-900/80">
      <Icon className="w-3.5 h-3.5 text-cyan-500" strokeWidth={1.8} />
      <span className="text-[11px] font-medium text-slate-400 tracking-widest uppercase">{title}</span>
    </div>
    <div className="p-3 flex-1 relative z-10 overflow-y-auto">{children}</div>
  </div>
);

const StatusDot = ({ active }: { active: boolean }) => (
  <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-mono tracking-wider',
    active ? 'text-emerald-400' : 'text-slate-600',
  )}>
    <span className={cn('w-1.5 h-1.5 rounded-full', active ? 'bg-emerald-400' : 'bg-slate-700')} />
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

  const colors = accent === 'rose'
    ? { border: 'border-rose-500/20', header: 'bg-rose-950/30 border-rose-900/40', text: 'text-rose-400', close: 'text-rose-500 hover:text-rose-300' }
    : accent === 'fuchsia'
    ? { border: 'border-fuchsia-500/20', header: 'bg-fuchsia-950/30 border-fuchsia-900/40', text: 'text-fuchsia-400', close: 'text-fuchsia-500 hover:text-fuchsia-300' }
    : { border: 'border-cyan-500/20', header: 'bg-cyan-950/30 border-cyan-900/40', text: 'text-cyan-400', close: 'text-cyan-500 hover:text-cyan-300' };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className={cn('w-full bg-[#0a0f1a] flex flex-col max-h-[90vh] border', maxWidth, colors.border)}>
        <div className={cn('px-4 py-2.5 border-b flex justify-between items-center', colors.header)}>
          <div className={cn('flex items-center gap-2', colors.text)}>
            <Icon className="w-4 h-4" strokeWidth={1.8} />
            <span className="text-xs font-medium tracking-widest">{title}</span>
          </div>
          <button type="button" onClick={onClose} disabled={closeDisabled}
            className={cn('transition-colors disabled:opacity-30', colors.close)}>
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
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
      <div className="p-4 text-xs relative group overflow-y-auto">
        <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyBtn text={configJson} />
        </div>
        <div className="space-y-1 text-slate-500 mb-3">
          <div>// Backend: <span className="text-cyan-400">{backendEndpoint}</span></div>
          <div>// Channel: <span className="text-cyan-400">{channel.channelId}</span></div>
        </div>
        <pre className="text-slate-300 leading-relaxed overflow-x-auto font-mono">{configJson}</pre>
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
    <ModalShell title="CONNECTION_PARAMS" icon={QrCode} accent="fuchsia" onClose={onClose} maxWidth="max-w-lg">
      <div className="p-6 flex flex-col items-center gap-5 overflow-y-auto">
        <div className="w-full grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs border border-fuchsia-900/30 bg-black/30 p-3">
          <span className="text-fuchsia-600">NODE</span>
          <span className="text-fuchsia-300">{channel.label || channel.channelId}</span>
          <span className="text-fuchsia-600">USER</span>
          <span className="text-fuchsia-300">{user.senderId}</span>
          <span className="text-fuchsia-600">TOKEN</span>
          <span className="font-mono text-fuchsia-300">{user.token.slice(0, 8)}…{user.token.slice(-4)}</span>
        </div>
        <div className="p-4 bg-white">
          <QRCodeImage value={connectionUrl} size={180} />
        </div>
        <div className="w-full space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs text-fuchsia-500 tracking-widest">URL</span>
            <CopyBtn text={connectionUrl} />
          </div>
          <div className="p-3 bg-black/40 border border-fuchsia-900/30 font-mono text-xs text-fuchsia-200 break-all">{connectionUrl}</div>
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
    <ModalShell title="DIAGNOSTIC_REPORT" icon={Activity} onClose={onClose}>
      <div className="p-4 overflow-y-auto text-xs space-y-1.5">
        {isLoading ? (
          <div className="flex items-center gap-2 text-cyan-600 animate-pulse">
            <Activity className="w-4 h-4" />
            <span>SCANNING…</span>
          </div>
        ) : lines.map((line, i) => (
          <div key={`${line}-${i}`} className={cn('border-l-2 pl-3 py-1 font-mono',
            line.includes('ERR') ? 'border-rose-500 text-rose-400' :
            line.includes('WARN') ? 'border-amber-500 text-amber-400' :
            'border-slate-700 text-slate-400',
          )}>
            <span className="text-slate-600 mr-2">[{new Date().toLocaleTimeString()}]</span>
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
  const accent = state.accent ?? (isConfirm ? 'rose' : 'cyan');
  return (
    <ModalShell title={state.title} icon={accent === 'rose' ? ShieldAlert : Activity} accent={accent} onClose={onClose} maxWidth="max-w-xl" closeDisabled={isSubmitting}>
      <div className="p-4 text-sm space-y-3 overflow-y-auto">
        <p className="text-slate-200 leading-relaxed whitespace-pre-wrap">{state.message}</p>
        {state.detail && <p className="text-xs text-slate-500 leading-relaxed">{state.detail}</p>}
        {error && <div className="text-rose-400 text-xs border border-rose-900/40 bg-rose-950/20 px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-3 pt-2">
          {isConfirm && (
            <button type="button" onClick={onClose} disabled={isSubmitting}
              className="px-4 py-2 border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors disabled:opacity-40">
              {state.cancelLabel ?? 'CANCEL'}
            </button>
          )}
          <button type="button" onClick={onConfirm} disabled={isSubmitting}
            className={cn('min-h-[40px] px-4 py-2 border transition-colors disabled:opacity-50',
              accent === 'rose' ? 'border-rose-700 text-rose-300 hover:bg-rose-900/50' : 'border-cyan-700 text-cyan-300 hover:bg-cyan-900/50',
            )}>
            {isSubmitting ? <RefreshCw className="w-4 h-4 animate-spin mx-auto" /> : state.confirmLabel ?? 'OK'}
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
    <ModalShell title={isEdit ? 'EDIT_CHANNEL' : 'NEW_CHANNEL'} icon={Network} onClose={onClose} closeDisabled={isSubmitting || submitSuccess}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void onSubmit(form); }} className="p-4 text-sm space-y-3 overflow-y-auto">
        <div className="text-xs text-slate-500">{isEdit ? 'Modify channel configuration' : 'Auto-generated defaults — expand Advanced to customize'}</div>
        <div className="flex items-center justify-between px-3 py-2 bg-slate-900/60 border border-slate-800">
          <div className="text-xs text-slate-300 font-mono">
            <span className="text-slate-500 mr-1">ID:</span>{form.channelId}
            <span className="text-slate-600 mx-2">│</span>
            <span className="text-slate-500 mr-1">LABEL:</span>{form.label}
          </div>
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-xs text-cyan-500 hover:text-cyan-400">
            {showAdvanced ? '▴ Collapse' : '▾ Advanced'}
          </button>
        </div>
        {showAdvanced && (
          <div className="space-y-4 border-l-2 border-slate-800 pl-4">
            <div className="space-y-1.5">
              <label htmlFor="ch-id" className={labelClassName}>Channel ID</label>
              <input id="ch-id" value={form.channelId} onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
                className={inputClassName} disabled={isEdit || isSubmitting} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="ch-label" className={labelClassName}>Label</label>
              <input id="ch-label" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                className={inputClassName} disabled={isSubmitting} />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <label htmlFor="ch-secret" className={labelClassName}>Secret</label>
                <button type="button" onClick={() => setForm((f) => ({ ...f, secret: randomToken() }))}
                  className="text-xs text-cyan-500 hover:text-cyan-400" disabled={isSubmitting}>Regenerate</button>
              </div>
              <input id="ch-secret" value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                className={inputClassName} disabled={isSubmitting} />
            </div>
          </div>
        )}
        {error && <div className="text-rose-400 text-xs border border-rose-900/30 bg-rose-950/20 px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-700 text-slate-400 hover:text-slate-200 transition-colors" disabled={isSubmitting}>Cancel</button>
          <button type="submit" disabled={isSubmitting || submitSuccess}
            className={cn('min-h-[40px] px-4 py-2 border transition-all disabled:opacity-50',
              submitSuccess ? 'border-emerald-500 text-emerald-300' : 'border-cyan-700 text-cyan-300 hover:bg-cyan-900/50')}>
            {submitSuccess ? <><Check className="w-4 h-4 inline mr-1" />Saved</> : isSubmitting ? <RefreshCw className="w-4 h-4 animate-spin mx-auto" /> : isEdit ? 'Update' : 'Create'}
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
    <ModalShell title={isEdit ? 'EDIT_USER' : 'ADD_USER'} icon={Users} onClose={onClose} closeDisabled={isSubmitting || submitSuccess}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void onSubmit(form); }} className="p-4 text-sm space-y-3 overflow-y-auto">
        <div className="text-xs text-slate-500">Channel: <span className="text-cyan-400">{channel.channelId}</span></div>
        <div className="flex items-center justify-between px-3 py-2 bg-slate-900/60 border border-slate-800">
          <div className="text-xs text-slate-300 font-mono"><span className="text-slate-500 mr-1">ID:</span>{form.senderId}</div>
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-xs text-cyan-500 hover:text-cyan-400">
            {showAdvanced ? '▴ Collapse' : '▾ Advanced'}
          </button>
        </div>
        {showAdvanced && (
          <div className="space-y-4 border-l-2 border-slate-800 pl-4">
            <div className="space-y-1.5">
              <label htmlFor="u-sid" className={labelClassName}>Sender ID</label>
              <input id="u-sid" value={form.senderId} onChange={(e) => setForm((f) => ({ ...f, senderId: e.target.value }))}
                className={inputClassName} disabled={isEdit || isSubmitting} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="u-cid" className={labelClassName}>Chat ID</label>
              <input id="u-cid" value={form.chatId} onChange={(e) => setForm((f) => ({ ...f, chatId: e.target.value }))}
                className={inputClassName} placeholder="optional" disabled={isSubmitting} />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <label htmlFor="u-tok" className={labelClassName}>Token</label>
                <button type="button" onClick={() => setForm((f) => ({ ...f, token: randomToken() }))}
                  className="text-xs text-cyan-500 hover:text-cyan-400" disabled={isSubmitting}>Regenerate</button>
              </div>
              <input id="u-tok" value={form.token} onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                className={inputClassName} disabled={isSubmitting} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="u-agents" className={labelClassName}>Allow Agents</label>
              <input id="u-agents" value={form.allowAgents} onChange={(e) => setForm((f) => ({ ...f, allowAgents: e.target.value }))}
                className={inputClassName} placeholder="comma separated, blank = all" disabled={isSubmitting} />
            </div>
            <label className="flex items-center gap-2 text-slate-300 text-xs">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                className="accent-cyan-500" disabled={isSubmitting} />
              Enabled
            </label>
          </div>
        )}
        {error && <div className="text-rose-400 text-xs border border-rose-900/30 bg-rose-950/20 px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-700 text-slate-400 hover:text-slate-200 transition-colors" disabled={isSubmitting}>Cancel</button>
          <button type="submit" disabled={isSubmitting || submitSuccess}
            className={cn('min-h-[40px] px-4 py-2 border transition-all disabled:opacity-50',
              submitSuccess ? 'border-emerald-500 text-emerald-300' : 'border-cyan-700 text-cyan-300 hover:bg-cyan-900/50')}>
            {submitSuccess ? <><Check className="w-4 h-4 inline mr-1" />Saved</> : isSubmitting ? <RefreshCw className="w-4 h-4 animate-spin mx-auto" /> : isEdit ? 'Update' : 'Add'}
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
      <div className="min-h-screen bg-[#020617] text-cyan-500 flex items-center justify-center">
        <div className="text-center space-y-4">
          <Hexagon className="w-10 h-10 text-cyan-400 mx-auto animate-pulse" strokeWidth={1.2} />
          <p className="text-xs tracking-[0.25em] text-slate-500">INITIALIZING…</p>
        </div>
      </div>
    );
  }

  if (!isLogtoAuth && !isDevBypass) {
    return (
      <div className="min-h-screen bg-[#020617] text-slate-300 flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,oklch(0.18_0.04_220),oklch(0.06_0.02_250))] opacity-70" />
        <div className="absolute inset-0 bg-[linear-gradient(oklch(0.4_0.03_200/0.04)_1px,transparent_1px),linear-gradient(90deg,oklch(0.4_0.03_200/0.04)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_70%_70%_at_50%_50%,#000_10%,transparent_100%)] pointer-events-none" />
        <div className="relative z-10 w-full max-w-md p-10 bg-slate-950/80 border border-slate-800 text-center space-y-6">
          <Hexagon className="w-10 h-10 text-cyan-500 mx-auto" strokeWidth={1.2} />
          <h1 className="text-lg font-bold tracking-[0.3em] text-slate-200">{GATEWAY_NAME}</h1>
          <p className="text-xs tracking-[0.2em] text-slate-500">SSO_AUTH_REQUIRED</p>
          <button type="button" onClick={() => void signIn({
            redirectUri: window.location.origin + '/callback',
            postRedirectUri: window.location.origin + '/',
            clearTokens: true,
          })}
            className="w-full py-3 border border-cyan-800 text-cyan-400 hover:bg-cyan-950/50 hover:border-cyan-600 transition-all text-xs tracking-[0.2em] flex justify-center items-center gap-2">
            <Lock className="w-4 h-4" /> SIGN_IN_WITH_SSO
          </button>
        </div>
      </div>
    );
  }

  return <AdminDashboard logtoUser={logtoUser} onLogtoSignOut={() => void signOut(window.location.origin)} />;
}

// ═══════════════════════════════════════════════════════════════
// AdminDashboard (authenticated)
// ═══════════════════════════════════════════════════════════════

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

  const activeRelay = relayNodes.find((n) => n.id === selectedRelayId) ?? relayNodes[0] ?? DEFAULT_RELAY;
  const gatewayRelay: RelayNode = DEFAULT_RELAY;

  // ── AI Settings ──
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState({ llmEndpoint: '', llmApiKey: '', llmModel: '', suggestionModel: '', voiceRefineModel: '', suggestionPrompt: '', voiceRefinePrompt: '' });
  const [aiSettingsSaving, setAiSettingsSaving] = useState(false);
  const [aiSettingsTab, setAiSettingsTab] = useState<'provider' | 'suggestions' | 'voice'>('provider');

  const fetchAiSettings = useCallback(async () => {
    try {
      const data = await apiFetch<{ ok: boolean; llmEndpoint?: string; llmApiKey?: string; llmModel?: string; suggestionModel?: string; voiceRefineModel?: string; suggestionPrompt?: string; voiceRefinePrompt?: string }>('/api/ai-settings', activeRelay, undefined);
      if (data.ok) setAiSettings({ llmEndpoint: data.llmEndpoint || '', llmApiKey: data.llmApiKey || '', llmModel: data.llmModel || '', suggestionModel: data.suggestionModel || '', voiceRefineModel: data.voiceRefineModel || '', suggestionPrompt: data.suggestionPrompt || '', voiceRefinePrompt: data.voiceRefinePrompt || '' });
    } catch { /* ignore */ }
  }, [activeRelay]);

  const saveAiSettingsHandler = useCallback(async () => {
    setAiSettingsSaving(true);
    try { await apiFetch('/api/ai-settings', activeRelay, { method: 'PUT', body: JSON.stringify(aiSettings) }); } catch { /* ignore */ }
    setAiSettingsSaving(false);
  }, [activeRelay, aiSettings]);

  // ── Message Log ──
  type MessageRow = { id: string; channel_id: string; sender_id: string | null; agent_id: string | null; content: string | null; content_type: string; direction: string; timestamp: number; created_at: string };
  const [isMessageLogOpen, setIsMessageLogOpen] = useState(false);
  const [messageLogRows, setMessageLogRows] = useState<MessageRow[]>([]);
  const [messageLogTotal, setMessageLogTotal] = useState(0);
  const [messageLogChannel, setMessageLogChannel] = useState('');
  const [messageLogLoading, setMessageLogLoading] = useState(false);

  const fetchMessageLog = useCallback(async (channelFilter?: string) => {
    setMessageLogLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (channelFilter) params.set('channelId', channelFilter);
      const data = await apiFetch<{ ok: boolean; messages: MessageRow[]; total: number }>(`/api/messages?${params}`, activeRelay, undefined);
      if (data.ok) { setMessageLogRows(data.messages); setMessageLogTotal(data.total); }
    } catch { /* ignore */ }
    setMessageLogLoading(false);
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
    <div className="min-h-screen bg-[#020617] text-slate-300 font-sans overflow-hidden relative flex flex-col selection:bg-cyan-900 selection:text-cyan-50">
      {/* Subtle background */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,oklch(0.18_0.04_220),oklch(0.06_0.02_250))] opacity-50" />
      <div className="absolute inset-0 bg-[linear-gradient(oklch(0.4_0.03_200/0.03)_1px,transparent_1px),linear-gradient(90deg,oklch(0.4_0.03_200/0.03)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_20%,transparent_100%)] pointer-events-none" />

      {/* ── Header ── */}
      <header className="relative z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md px-3 py-2 flex justify-between items-center">
        <div className="flex items-center gap-3 lg:gap-5 min-w-0">
          <div className="flex items-center gap-2 text-cyan-500 shrink-0">
            <Hexagon className="w-4 h-4" strokeWidth={1.2} />
            <span className="text-xs lg:text-sm font-bold tracking-[0.2em] hidden sm:inline">{GATEWAY_NAME}</span>
          </div>
          <StatusDot active={!!relayState} />
          {/* Relay selector */}
          <div className="flex items-center gap-1.5 min-w-0">
            <Server className="w-3 h-3 text-fuchsia-400 shrink-0" strokeWidth={1.8} />
            <select value={selectedRelayId}
              onChange={(e) => { setSelectedRelayId(e.target.value); setRelayState(null); }}
              className="bg-transparent border border-slate-700 text-fuchsia-300 font-mono text-xs px-1.5 py-1 focus:outline-none focus:border-fuchsia-500 cursor-pointer min-w-0">
              {relayNodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
            <button type="button" onClick={() => setIsRelaySettingsOpen(true)}
              className="p-1.5 border border-slate-700 text-fuchsia-400 hover:text-fuchsia-300 hover:border-fuchsia-600 transition-colors" title="Settings">
              <Settings className="w-3.5 h-3.5" strokeWidth={1.8} />
            </button>
            <button type="button" onClick={() => { setIsAiSettingsOpen(true); void fetchAiSettings(); }}
              className="p-1.5 border border-slate-700 text-amber-400 hover:text-amber-300 hover:border-amber-600 transition-colors" title="AI Settings">
              <Sparkles className="w-3.5 h-3.5" strokeWidth={1.8} />
            </button>
            <button type="button" onClick={() => { setIsMessageLogOpen(true); void fetchMessageLog(); }}
              className="p-1.5 border border-slate-700 text-emerald-400 hover:text-emerald-300 hover:border-emerald-600 transition-colors" title="Message Log">
              <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={() => void refreshState()} disabled={isRefreshing}
            className="p-1.5 lg:px-3 lg:py-1.5 border border-slate-700 hover:border-cyan-700 hover:text-cyan-400 transition-colors flex items-center gap-1.5 text-xs" title="Refresh">
            <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
            <span className="hidden lg:inline">Refresh</span>
          </button>
          <button type="button" onClick={onLogtoSignOut}
            className="p-1.5 lg:px-3 lg:py-1.5 border border-slate-700 text-rose-400 hover:text-rose-300 hover:border-rose-700 transition-colors text-xs">
            <span className="hidden sm:inline">Sign out</span>
            <LogOut className="w-3.5 h-3.5 sm:hidden" />
          </button>
          {logtoUser && (
            <span className="text-slate-400 text-xs items-center gap-1 hidden md:flex" title={logtoUser.sub}>
              <Users className="w-3 h-3" />
              <span className="truncate max-w-[80px]">{logtoUser.name ?? logtoUser.username ?? logtoUser.email ?? logtoUser.sub}</span>
            </span>
          )}
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
            }} className="p-4 space-y-4">
              <div className="space-y-1.5">
                <label className={labelClassName}>Name</label>
                <input name="name" defaultValue={editingRelay.name} className={inputClassName} required />
              </div>
              <div className="space-y-1.5">
                <label className={labelClassName}>URL</label>
                <input name="url" defaultValue={editingRelay.url} placeholder="https://relay.example.com" className={inputClassName} required />
              </div>
              <div className="space-y-1.5">
                <label className={labelClassName}>Admin Token</label>
                <input name="adminToken" type="password" defaultValue={editingRelay.adminToken} className={inputClassName} />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setEditingRelay(null)} className="px-4 py-2 border border-slate-700 text-slate-400 hover:text-slate-200 transition-colors">Cancel</button>
                <button type="submit" className="px-4 py-2 border border-cyan-700 text-cyan-300 hover:bg-cyan-900/50 transition-colors">Save</button>
              </div>
            </form>
          ) : (
            <div className="p-4 space-y-3">
              {relayNodes.map((n) => (
                <div key={n.id} className={cn('px-4 py-3 border flex items-center justify-between gap-4',
                  n.id === selectedRelayId ? 'border-fuchsia-500/40 bg-fuchsia-950/20' : 'border-slate-800 bg-slate-900/40')}>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-200 font-medium truncate">{n.name}</div>
                    <div className="text-xs text-slate-500 font-mono truncate">{n.url}</div>
                    <div className="text-xs text-slate-600">{n.adminToken ? '●●●●●●●●' : 'NO_TOKEN'}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => setEditingRelay(n)} className="p-1.5 border border-slate-700 text-slate-500 hover:text-cyan-400 hover:border-cyan-700 transition-colors">
                      <Pencil className="w-3 h-3" />
                    </button>
                    {relayNodes.length > 1 && (
                      <button onClick={async () => {
                        await deleteRelayNodeFromServer(n.id, gatewayRelay);
                        const next = relayNodes.filter((x) => x.id !== n.id);
                        await updateRelayNodes(next);
                        if (selectedRelayId === n.id) { setSelectedRelayId(next[0].id); setRelayState(null); }
                      }} className="p-1.5 border border-slate-700 text-rose-500 hover:text-rose-300 hover:border-rose-700 transition-colors">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button onClick={() => setEditingRelay({ id: '', name: '', url: '', adminToken: '' })}
                className="w-full py-3 border border-dashed border-slate-700 text-slate-500 text-xs hover:text-fuchsia-400 hover:border-fuchsia-700 transition-all flex items-center justify-center gap-2">
                <Plus className="w-4 h-4" /> ADD_RELAY_NODE
              </button>
              <div className="pt-4 border-t border-slate-800 mt-4">
                <button type="button" onClick={() => { void runDiagnostic(); setIsRelaySettingsOpen(false); }}
                  className="w-full py-2.5 border border-slate-700 text-cyan-400 hover:bg-cyan-950/50 transition-colors flex items-center justify-center gap-2 text-xs">
                  <Activity className="w-4 h-4" /> RUN_DIAGNOSTIC
                </button>
              </div>
            </div>
          )}
        </ModalShell>
      )}

      {/* ── AI Settings Modal (redesigned with tabs) ── */}
      {isAiSettingsOpen && (
        <ModalShell title="AI_SETTINGS" icon={Sparkles} onClose={() => setIsAiSettingsOpen(false)} maxWidth="max-w-xl">
          {/* Tab bar */}
          <div className="flex border-b border-slate-800 -mx-5 px-5 mb-5">
            {([['provider', 'Provider', Globe], ['suggestions', 'Suggestions', Sparkles], ['voice', 'Voice', Mic]] as const).map(([key, label, TabIcon]) => (
              <button key={key} type="button" onClick={() => setAiSettingsTab(key)}
                className={cn('flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium tracking-wide transition-colors border-b-2 -mb-px',
                  aiSettingsTab === key ? 'border-amber-500 text-amber-400' : 'border-transparent text-slate-500 hover:text-slate-300')}>
                <TabIcon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Provider tab */}
          {aiSettingsTab === 'provider' && (
            <div className="space-y-4">
              <p className="text-[11px] text-slate-500 leading-relaxed">Override the default Azure OpenAI config. Leave empty to use hardcoded defaults (gpt-5.4-mini).</p>
              <div>
                <label className={labelClassName}>Endpoint</label>
                <input className={inputClassName} value={aiSettings.llmEndpoint}
                  onChange={e => setAiSettings(s => ({ ...s, llmEndpoint: e.target.value }))}
                  placeholder="https://resley-east-us-2-resource.openai.azure.com/openai/v1" />
              </div>
              <div>
                <label className={labelClassName}>API Key</label>
                <input className={inputClassName} type="password" value={aiSettings.llmApiKey}
                  onChange={e => setAiSettings(s => ({ ...s, llmApiKey: e.target.value }))}
                  placeholder="Leave empty → AZURE_OPENAI_API_KEY env" />
              </div>
              <div>
                <label className={labelClassName}>Default Model</label>
                <input className={inputClassName} value={aiSettings.llmModel}
                  onChange={e => setAiSettings(s => ({ ...s, llmModel: e.target.value }))}
                  placeholder="gpt-5.4-mini" />
                <p className="text-[10px] text-slate-600 mt-1">Used when no per-feature model is set.</p>
              </div>
            </div>
          )}

          {/* Suggestions tab */}
          {aiSettingsTab === 'suggestions' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-medium text-amber-400 tracking-widest uppercase">Smart Suggestions</span>
              </div>
              <div>
                <label className={labelClassName}>Model</label>
                <input className={inputClassName} value={aiSettings.suggestionModel}
                  onChange={e => setAiSettings(s => ({ ...s, suggestionModel: e.target.value }))}
                  placeholder={`(default: ${aiSettings.llmModel || 'gpt-5.4-mini'})`} />
                <p className="text-[10px] text-slate-600 mt-1">Override model for suggestions only. Empty = use default model above.</p>
              </div>
              <div>
                <label className={labelClassName}>System Prompt</label>
                <textarea className={inputClassName + ' min-h-[120px] resize-y'} value={aiSettings.suggestionPrompt}
                  onChange={e => setAiSettings(s => ({ ...s, suggestionPrompt: e.target.value }))}
                  placeholder="Leave empty for built-in prompt. User custom prompts are appended to this." />
              </div>
            </div>
          )}

          {/* Voice tab */}
          {aiSettingsTab === 'voice' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-1">
                <Mic className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-medium text-amber-400 tracking-widest uppercase">Voice Refinement</span>
              </div>
              <div>
                <label className={labelClassName}>Model</label>
                <input className={inputClassName} value={aiSettings.voiceRefineModel}
                  onChange={e => setAiSettings(s => ({ ...s, voiceRefineModel: e.target.value }))}
                  placeholder={`(default: ${aiSettings.llmModel || 'gpt-5.4-mini'})`} />
                <p className="text-[10px] text-slate-600 mt-1">Override model for voice refinement only. Empty = use default model above.</p>
              </div>
              <div>
                <label className={labelClassName}>System Prompt</label>
                <textarea className={inputClassName + ' min-h-[120px] resize-y'} value={aiSettings.voiceRefinePrompt}
                  onChange={e => setAiSettings(s => ({ ...s, voiceRefinePrompt: e.target.value }))}
                  placeholder="Leave empty for built-in prompt. User custom prompts are appended to this." />
              </div>
            </div>
          )}

          {/* Save button */}
          <div className="mt-5 pt-4 border-t border-slate-800">
            <button type="button" onClick={() => void saveAiSettingsHandler()} disabled={aiSettingsSaving}
              className="w-full py-2.5 border border-amber-700/60 text-amber-400 hover:bg-amber-950/40 transition-colors flex items-center justify-center gap-2 text-xs disabled:opacity-50">
              {aiSettingsSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              SAVE_SETTINGS
            </button>
          </div>
        </ModalShell>
      )}

      {/* ── Message Log Modal ── */}
      {isMessageLogOpen && (
        <ModalShell title="MESSAGE_LOG" icon={MessageSquare} onClose={() => setIsMessageLogOpen(false)} maxWidth="max-w-3xl">
          <div className="space-y-3">
            {/* Filter bar */}
            <div className="flex items-center gap-2">
              <select value={messageLogChannel}
                onChange={e => { setMessageLogChannel(e.target.value); void fetchMessageLog(e.target.value || undefined); }}
                className="bg-slate-900/60 border border-slate-700 text-slate-300 text-xs px-2.5 py-1.5 font-mono focus:outline-none focus:border-emerald-500 flex-1">
                <option value="">All Channels</option>
                {relayState?.channels?.map(ch => (
                  <option key={ch.channelId} value={ch.channelId}>{ch.label || ch.channelId}</option>
                ))}
              </select>
              <button type="button" onClick={() => void fetchMessageLog(messageLogChannel || undefined)} disabled={messageLogLoading}
                className="p-1.5 border border-slate-700 text-emerald-400 hover:border-emerald-600 transition-colors">
                <RefreshCw className={cn('w-3.5 h-3.5', messageLogLoading && 'animate-spin')} />
              </button>
              <span className="text-[10px] text-slate-500 font-mono tabular-nums">{messageLogTotal} total</span>
            </div>

            {/* Message list */}
            <div className="max-h-[60vh] overflow-y-auto border border-slate-800">
              {messageLogRows.length === 0 && !messageLogLoading && (
                <div className="py-12 text-center text-slate-600 text-xs">No messages found</div>
              )}
              {messageLogLoading && messageLogRows.length === 0 && (
                <div className="py-12 text-center text-slate-600 text-xs flex items-center justify-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading…
                </div>
              )}
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-900/95 backdrop-blur-sm">
                  <tr className="text-slate-500 text-left">
                    <th className="px-2 py-1.5 font-medium">Time</th>
                    <th className="px-2 py-1.5 font-medium">Channel</th>
                    <th className="px-2 py-1.5 font-medium">Dir</th>
                    <th className="px-2 py-1.5 font-medium">Sender</th>
                    <th className="px-2 py-1.5 font-medium">Content</th>
                  </tr>
                </thead>
                <tbody>
                  {messageLogRows.map(msg => (
                    <tr key={msg.id} className="border-t border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                      <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap tabular-nums">{new Date(msg.timestamp).toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-cyan-400 font-mono">{msg.channel_id}</td>
                      <td className="px-2 py-1.5">
                        <span className={cn('inline-block w-1.5 h-1.5 rounded-full mr-1', msg.direction === 'inbound' ? 'bg-blue-400' : 'bg-emerald-400')} />
                        <span className={msg.direction === 'inbound' ? 'text-blue-400' : 'text-emerald-400'}>{msg.direction === 'inbound' ? '↑ IN' : '↓ OUT'}</span>
                      </td>
                      <td className="px-2 py-1.5 text-slate-400 font-mono">{msg.sender_id || msg.agent_id || '—'}</td>
                      <td className="px-2 py-1.5 text-slate-300 max-w-[300px] truncate" title={msg.content || ''}>{msg.content?.slice(0, 100) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
      <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className={cn(
            'pointer-events-auto px-4 py-2.5 text-sm border animate-[fadeSlideIn_0.3s_ease-out]',
            t.type === 'success' ? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-300' : 'bg-rose-950/90 border-rose-500/40 text-rose-300',
          )}>
            <div className="flex items-center gap-2">
              {t.type === 'success' ? <Check className="w-4 h-4" /> : <CircleAlert className="w-4 h-4" />}
              <span>{t.message}</span>
              <button onClick={() => removeToast(t.id)} className="ml-2 opacity-50 hover:opacity-100">×</button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Main Content ── */}
      <main className="flex-1 relative z-10 p-4 lg:p-6 flex flex-col gap-5 overflow-hidden">
        {dashboardError && (
          <div className="border border-rose-900/30 bg-rose-950/20 px-4 py-3 text-xs text-rose-400">{dashboardError}</div>
        )}

        {/* Overview */}
        <Panel title="RELAY_GATEWAY" icon={Server} className="shrink-0">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm lg:text-base font-bold text-slate-100 tracking-wide">{GATEWAY_NAME}</span>
              <span className="font-mono text-xs text-slate-500 truncate">{gatewayEndpoint}</span>
            </div>
            <div className="flex items-center gap-6 shrink-0">
              <div className="flex flex-col items-end">
                <span className="text-[10px] text-slate-500">CHANNELS</span>
                <span className="font-mono text-xl text-cyan-400">{relayState?.channels.length ?? 0}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[10px] text-slate-500">BACKENDS</span>
                <span className="font-mono text-xl text-cyan-400">{relayState?.stats.backendCount ?? 0}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[10px] text-slate-500">CLIENTS</span>
                <span className="font-mono text-xl text-cyan-400">{relayState?.stats.clientCount ?? 0}</span>
              </div>
              <StatusDot active={gatewayStatus === 'RUNNING'} />
            </div>
          </div>
        </Panel>

        {/* Channels + Users */}
        <div className="flex-1 flex flex-col lg:flex-row gap-3 min-h-0">
          {/* Channel List */}
          <Panel title="CHANNELS" icon={Network} className="w-full lg:w-[280px] xl:w-[320px] flex flex-col shrink-0">
            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {relayState?.channels.length ? relayState.channels.map((ch) => (
                <div key={ch.channelId} onClick={() => setSelectedChannelId(ch.channelId)}
                  className={cn('px-3 py-2 border transition-all cursor-pointer group relative',
                    highlightChannelId === ch.channelId ? 'bg-cyan-950/30 border-cyan-400/50 animate-[highlightPulse_1s_ease-in-out_2]' :
                    selectedChannelId === ch.channelId ? 'bg-slate-900/60 border-cyan-700/50' : 'bg-slate-900/30 border-slate-800 hover:border-slate-600')}>
                  {selectedChannelId === ch.channelId && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-cyan-500" />}
                  <div className="flex justify-between items-center gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('text-sm font-medium truncate', selectedChannelId === ch.channelId ? 'text-slate-100' : 'text-slate-300')}>
                        {ch.label || ch.channelId}
                      </span>
                      {ch.label && <span className="text-xs text-slate-600 shrink-0">{ch.channelId}</span>}
                    </div>
                    <StatusDot active={ch.backendConnected} />
                  </div>
                  <div className="flex items-center gap-4 mt-1.5 text-xs text-slate-500">
                    <span><span className="text-slate-300">{ch.clientCount}</span> clients</span>
                    <span><span className="text-slate-300">{ch.userCount}</span> users</span>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1 mt-1.5">
                    <button onClick={(e) => { e.stopPropagation(); setChannelModalState({ mode: 'edit', channel: ch }); setChannelFormError(null); }}
                      className="p-1.5 border border-slate-700 text-slate-500 hover:text-cyan-400 hover:border-cyan-700 transition-colors" title="Edit">
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setConfigChannelId(ch.channelId); }}
                      className="p-1.5 border border-slate-700 text-slate-500 hover:text-cyan-400 hover:border-cyan-700 transition-colors" title="Config">
                      <Settings className="w-3 h-3" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteChannel(ch); }}
                      className="p-1.5 border border-slate-700 text-slate-500 hover:text-rose-400 hover:border-rose-700 transition-colors" title="Delete">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-sm py-8">
                  <Database className="w-8 h-8 mb-3 opacity-50" />
                  <span>No channels</span>
                </div>
              )}
            </div>
            <button onClick={() => { setChannelModalState({ mode: 'create' }); setChannelFormError(null); }}
              className="mt-3 w-full py-2.5 border border-dashed border-slate-700 text-slate-500 text-xs hover:text-cyan-400 hover:border-cyan-600 transition-all flex items-center justify-center gap-2">
              <Plus className="w-4 h-4" /> NEW_CHANNEL
            </button>
          </Panel>

          <div className="hidden lg:flex flex-col justify-center px-1">
            <ChevronRight className="w-5 h-5 text-slate-800" />
          </div>

          {/* User Table */}
          <Panel title={`USERS · ${selectedChannel?.label || selectedChannel?.channelId || 'select channel'}`} icon={Users} className="w-full lg:flex-1 flex flex-col">
            <div className="flex-1 overflow-y-auto">
              {!selectedChannel ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-sm py-8">
                  <ShieldAlert className="w-8 h-8 mb-3 opacity-50" />
                  <span>Select a channel</span>
                </div>
              ) : selectedChannel.users.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-sm py-8">
                  <Database className="w-8 h-8 mb-3 opacity-50" />
                  <span>No users registered</span>
                </div>
              ) : (
                <table className="w-full text-left font-mono text-sm">
                  <caption className="sr-only">User configurations</caption>
                  <thead>
                    <tr className="text-[11px] text-slate-500 border-b border-slate-800 uppercase tracking-wider">
                      <th scope="col" className="pb-2 font-normal pl-2">Sender</th>
                      <th scope="col" className="pb-2 font-normal">Token</th>
                      <th scope="col" className="pb-2 font-normal">Status</th>
                      <th scope="col" className="pb-2 font-normal">Chat</th>
                      <th scope="col" className="pb-2 font-normal text-right pr-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {selectedChannel.users.map((user) => (
                      <tr key={user.senderId} className={cn('hover:bg-slate-900/50 transition-colors group',
                        highlightUserId === user.senderId && 'bg-cyan-950/20 animate-[highlightPulse_1s_ease-in-out_2]')}>
                        <td className="py-2 pl-2">
                          <div className="flex items-center gap-1.5">
                            <Lock className="w-3 h-3 text-slate-600" />
                            <span className="text-slate-200">{user.senderId}</span>
                          </div>
                        </td>
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-500 text-xs">{user.token.slice(0, 8)}…{user.token.slice(-4)}</span>
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity"><CopyBtn text={user.token} /></div>
                          </div>
                        </td>
                        <td className="py-2"><StatusDot active={user.enabled} /></td>
                        <td className="py-2 text-slate-400 text-xs">{user.chatId || '—'}</td>
                        <td className="py-2 pr-2 text-right">
                          <div className="inline-flex gap-1">
                            <button onClick={() => setQrTarget({ channelId: selectedChannel.channelId, senderId: user.senderId })}
                              className="p-1.5 border border-slate-700 text-fuchsia-400 hover:text-fuchsia-300 hover:border-fuchsia-600 transition-colors" title="Connect">
                              <QrCode className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => { setUserModalState({ mode: 'edit', user }); setUserFormError(null); }}
                              className="p-1.5 border border-slate-700 text-slate-500 hover:text-cyan-400 hover:border-cyan-700 transition-colors" title="Edit">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleDeleteUser(user)}
                              className="p-1.5 border border-slate-700 text-slate-500 hover:text-rose-400 hover:border-rose-700 transition-colors" title="Delete">
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
            <div className="mt-3 pt-3 border-t border-slate-800 flex justify-between items-center gap-4">
              <div className="font-mono text-[10px] text-slate-600 tracking-wider">
                REFRESH: {REFRESH_INTERVAL / 1000}S
                <span className="ml-3">SYNC: {formatTimestamp(relayState?.timestamp)}</span>
              </div>
              <button onClick={() => { setUserModalState({ mode: 'create' }); setUserFormError(null); }}
                disabled={!selectedChannel}
                className="px-3 py-1.5 border border-slate-700 text-cyan-400 font-mono text-xs hover:bg-cyan-950/50 hover:border-cyan-600 transition-colors flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed">
                <Plus className="w-3 h-3" /> ADD_USER
              </button>
            </div>
          </Panel>
        </div>
      </main>
    </div>
  );
}

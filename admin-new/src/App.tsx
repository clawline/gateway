import { useEffect, useState, type FormEvent, type ReactNode, type SVGProps } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type IconProps = SVGProps<SVGSVGElement>;

const IconBase = ({ children, ...props }: IconProps & { children: ReactNode }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    {children}
  </svg>
);

const Activity = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />
  </IconBase>
);

const Check = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m5 12 4 4L19 6" />
  </IconBase>
);

const ChevronRight = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m9 18 6-6-6-6" />
  </IconBase>
);

const Copy = (props: IconProps) => (
  <IconBase {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </IconBase>
);

const Database = (props: IconProps) => (
  <IconBase {...props}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </IconBase>
);

const Globe = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18" />
    <path d="M12 3a15 15 0 0 0 0 18" />
  </IconBase>
);

const Hexagon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m6 4 12 0 6 8-6 8H6L0 12 6 4Z" transform="translate(0 0) scale(.75) translate(4 4)" />
  </IconBase>
);

const Lock = (props: IconProps) => (
  <IconBase {...props}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </IconBase>
);

const Network = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="18" r="2" />
    <circle cx="12" cy="6" r="2" />
    <path d="M12 8v4" />
    <path d="M7.5 16.5 10.5 9.5" />
    <path d="M16.5 16.5 13.5 9.5" />
  </IconBase>
);

const Pencil = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M12 20h9" />
    <path d="m16.5 3.5 4 4L8 20l-5 1 1-5Z" />
  </IconBase>
);

const Plus = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </IconBase>
);

const QrCode = (props: IconProps) => (
  <IconBase {...props}>
    <rect x="3" y="3" width="6" height="6" />
    <rect x="15" y="3" width="6" height="6" />
    <rect x="3" y="15" width="6" height="6" />
    <path d="M15 15h3v3h-3z" />
    <path d="M18 18h3v3h-3z" />
    <path d="M15 21h3" />
    <path d="M21 15v3" />
  </IconBase>
);

const Radio = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="2" />
    <path d="M16.24 7.76a6 6 0 0 1 0 8.48" />
    <path d="M7.76 16.24a6 6 0 0 1 0-8.48" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
  </IconBase>
);

const RefreshCw = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M21 2v6h-6" />
    <path d="M3 22v-6h6" />
    <path d="M20 8a9 9 0 0 0-15-3" />
    <path d="M4 16a9 9 0 0 0 15 3" />
  </IconBase>
);

const Server = (props: IconProps) => (
  <IconBase {...props}>
    <rect x="3" y="4" width="18" height="6" rx="2" />
    <rect x="3" y="14" width="18" height="6" rx="2" />
    <path d="M7 7h.01" />
    <path d="M7 17h.01" />
    <path d="M11 7h6" />
    <path d="M11 17h6" />
  </IconBase>
);

const Settings = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3" />
    <path d="M12 19v3" />
    <path d="m4.93 4.93 2.12 2.12" />
    <path d="m16.95 16.95 2.12 2.12" />
    <path d="M2 12h3" />
    <path d="M19 12h3" />
    <path d="m4.93 19.07 2.12-2.12" />
    <path d="m16.95 7.05 2.12-2.12" />
  </IconBase>
);

const ShieldAlert = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M12 3 5 6v6c0 5 3.5 8 7 9 3.5-1 7-4 7-9V6l-7-3Z" />
    <path d="M12 8v5" />
    <path d="M12 16h.01" />
  </IconBase>
);

const Trash2 = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </IconBase>
);

const Users = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="9" cy="8" r="3" />
    <path d="M4 19a5 5 0 0 1 10 0" />
    <circle cx="17" cy="9" r="2.5" />
    <path d="M14.5 19a4 4 0 0 1 6 0" />
  </IconBase>
);

const QRCodeImage = ({ value, size }: { value: string; size: number }) => {
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(value)}`;
  return <img src={src} alt="QR code" width={size} height={size} className="block" />;
};

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

type ChannelModalState =
  | {
      mode: 'create' | 'edit';
      channel?: RelayChannel;
    }
  | null;

type UserModalState =
  | {
      mode: 'create' | 'edit';
      user?: RelayUser;
    }
  | null;

const ADMIN_TOKEN_STORAGE_KEY = 'clawline-admin-token';
const GATEWAY_NAME = 'CLAWLINE_GATEWAY';
const GATEWAY_VERSION = 'LIVE';


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
    ['🥥', 'coconut'], ['🦔', 'durian'], ['💚', 'guava'], ['🟡', 'jackfruit'], ['🟠', 'kumquat'],
    ['🔴', 'lychee'], ['🍈', 'melon'], ['🫒', 'olive'], ['🍑', 'peach'], ['🍐', 'pear'],
    ['🍍', 'pineapple'], ['🟣', 'plum'], ['❤️', 'pomegranate'], ['⭐', 'starfruit'], ['🥑', 'avocado'],
    ['🟠', 'apricot'], ['🫐', 'blackberry'], ['🍈', 'cantaloupe'], ['🔴', 'cranberry'], ['🍊', 'grapefruit'],
    ['💚', 'lime'], ['🍊', 'mandarin'], ['🟣', 'mulberry'], ['💜', 'passion-fruit'], ['🟠', 'persimmon'],
    ['🔴', 'rambutan'], ['💚', 'soursop'], ['🟤', 'tamarind'], ['💛', 'yuzu'], ['🟤', 'longan'],
  ];
  const [emoji, name] = fruits[Math.floor(Math.random() * fruits.length)];
  return { id: name, label: `${emoji} ${name}` };
}

function randomSenderId() {
  const animals = [
    'falcon', 'tiger', 'wolf', 'panther', 'eagle', 'hawk', 'cobra', 'viper',
    'lynx', 'fox', 'bear', 'shark', 'whale', 'dolphin', 'otter', 'raven',
    'owl', 'crane', 'heron', 'jaguar', 'leopard', 'puma', 'cheetah', 'bison',
    'elk', 'moose', 'badger', 'ferret', 'mink', 'seal', 'walrus', 'penguin',
    'flamingo', 'pelican', 'toucan', 'parrot', 'sparrow', 'robin', 'finch', 'wren',
    'mantis', 'beetle', 'hornet', 'wasp', 'gecko', 'iguana', 'chameleon', 'turtle',
    'salmon', 'trout', 'marlin', 'barracuda', 'stingray', 'octopus', 'squid', 'crab',
    'lobster', 'starling', 'osprey', 'condor',
  ];
  return animals[Math.floor(Math.random() * animals.length)];
}

function normalizeBaseUrl(value?: string) {
  return value?.replace(/\/+$/, '') ?? '';
}

function httpToWs(url: string) {
  if (url.startsWith('https://')) {
    return `wss://${url.slice('https://'.length)}`;
  }
  if (url.startsWith('http://')) {
    return `ws://${url.slice('http://'.length)}`;
  }
  return url;
}

function buildGatewayEndpoint(state: RelayState | null) {
  if (!state) {
    return window.location.origin;
  }
  return normalizeBaseUrl(state.publicBaseUrl) || normalizeBaseUrl(state.pluginBackendUrl) || window.location.origin;
}

function buildPluginConfig(channel: RelayChannel, backendEndpoint: string) {
  return JSON.stringify(
    {
      channels: {
        clawline: {
          enabled: true,
          connectionMode: 'relay',
          relay: {
            url: backendEndpoint,
            channelId: channel.channelId,
            secret: channel.secret,
            instanceId: 'openclaw-node-01',
          },
        },
      },
    },
    null,
    2,
  );
}

function buildClientConnectUrl(state: RelayState | null, channel: RelayChannel, user: RelayUser) {
  const base = normalizeBaseUrl(state?.publicBaseUrl) || window.location.origin;
  const wsBase = httpToWs(base);
  const serverUrl = `${wsBase}/client?channelId=${encodeURIComponent(channel.channelId)}&token=${encodeURIComponent(user.token)}${user.chatId ? `&chatId=${encodeURIComponent(user.chatId)}` : ''}`;
  return `openclaw://connect?serverUrl=${encodeURIComponent(serverUrl)}`;
}

function formatTimestamp(timestamp?: number) {
  if (!timestamp) {
    return 'N/A';
  }
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

  for (const channel of state.channels) {
    lines.push(
      `INFO: CHANNEL=${channel.channelId} LABEL=${channel.label ?? 'UNSET'} BACKEND=${
        channel.backendConnected ? 'ONLINE' : 'OFFLINE'
      } CLIENTS=${channel.clientCount} USERS=${channel.userCount}`,
    );
    lines.push(`INFO: CHANNEL=${channel.channelId} TOKEN_PARAM=${channel.tokenParam} SECRET=${channel.secretMasked}`);
    if (channel.instanceId) {
      lines.push(`INFO: CHANNEL=${channel.channelId} INSTANCE_ID=${channel.instanceId}`);
    } else {
      lines.push(`WARN: CHANNEL=${channel.channelId} INSTANCE_ID=UNBOUND`);
    }
    if (channel.lastConnectedAt) {
      lines.push(`INFO: CHANNEL=${channel.channelId} LAST_CONNECTED=${formatTimestamp(channel.lastConnectedAt)}`);
    }
    if (channel.lastDisconnectedAt) {
      lines.push(`WARN: CHANNEL=${channel.channelId} LAST_DISCONNECTED=${formatTimestamp(channel.lastDisconnectedAt)}`);
    }
  }

  return lines;
}

async function parseApiError(response: Response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string') {
      return payload.error;
    }
  } catch {
    // Fall through to generic status message.
  }
  return `${response.status} ${response.statusText}`.trim();
}

async function apiFetch<T>(path: string, token: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set('X-Relay-Admin-Token', token);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new ApiError(response.status, await parseApiError(response));
  }

  return (await response.json()) as T;
}

const inputClassName =
  'w-full bg-cyan-950/20 border border-cyan-800 p-3 text-cyan-300 focus:outline-none focus:border-cyan-400 focus:bg-cyan-950/40 transition-all font-mono text-sm';

const labelClassName = 'text-[10px] text-cyan-500 tracking-widest';

const CopyBtn = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button onClick={handleCopy} className="text-cyan-500/50 hover:text-cyan-400 transition-colors">
      {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
    </button>
  );
};

const Panel = ({
  title,
  icon: Icon,
  children,
  className,
  glow = false,
}: {
  title: string;
  icon: typeof Server;
  children: ReactNode;
  className?: string;
  glow?: boolean;
}) => (
  <div className={cn('relative bg-black/40 border border-cyan-900/50 flex flex-col overflow-hidden group', className)}>
    {glow && (
      <div className="absolute -inset-px bg-gradient-to-b from-cyan-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    )}
    <div className="flex items-center gap-2 px-4 py-2 border-b border-cyan-900/50 bg-cyan-950/20">
      <Icon className="w-4 h-4 text-cyan-500" />
      <span className="font-mono text-xs font-bold tracking-widest text-cyan-100">{title}</span>
    </div>
    <div className="p-4 flex-1 relative z-10 overflow-y-auto">{children}</div>
  </div>
);

const StatusBadge = ({ status }: { status: string }) => {
  const normalized = status.toLowerCase();
  const isActive = normalized === 'online' || normalized === 'running' || normalized === 'enabled';

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 px-2 py-0.5 border font-mono text-[10px] tracking-tighter transition-all duration-500',
        isActive
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
          : 'bg-slate-800/30 text-slate-500 border-slate-700/30 opacity-70',
      )}
    >
      <div className="relative flex items-center justify-center w-2 h-2">
        <div className={cn('w-1.5 h-1.5 rounded-full', isActive ? 'bg-emerald-400' : 'bg-slate-600')} />
      </div>
      <span>{status.toUpperCase()}</span>
    </div>
  );
};

const ModalShell = ({
  accent = 'cyan',
  title,
  icon: Icon,
  children,
  onClose,
  maxWidth = 'max-w-2xl',
}: {
  accent?: 'cyan' | 'fuchsia';
  title: string;
  icon: typeof Activity;
  children: ReactNode;
  onClose: () => void;
  maxWidth?: string;
}) => {
  const accentClasses =
    accent === 'fuchsia'
      ? {
          border: 'border-fuchsia-500/30',
          shadow: 'shadow-[0_0_50px_rgba(217,70,239,0.2)]',
          headerBorder: 'border-fuchsia-900/50',
          headerBg: 'bg-fuchsia-950/20',
          text: 'text-fuchsia-400',
          close: 'text-fuchsia-600 hover:text-fuchsia-400',
        }
      : {
          border: 'border-cyan-500/30',
          shadow: 'shadow-[0_0_50px_rgba(6,182,212,0.2)]',
          headerBorder: 'border-cyan-900/50',
          headerBg: 'bg-cyan-950/20',
          text: 'text-cyan-400',
          close: 'text-cyan-600 hover:text-cyan-400',
        };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className={cn('w-full bg-[#020617] flex flex-col max-h-[85vh]', maxWidth, accentClasses.border, accentClasses.shadow)}>
        <div className={cn('p-4 border-b flex justify-between items-center', accentClasses.headerBorder, accentClasses.headerBg)}>
          <div className={cn('flex items-center gap-2', accentClasses.text)}>
            <Icon className="w-5 h-5" />
            <span className="font-mono text-sm font-bold tracking-widest uppercase">{title}</span>
          </div>
          <button onClick={onClose} className={cn('font-mono text-xs', accentClasses.close)}>
            [ CLOSE ]
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

const NodeConfigModal = ({
  channel,
  backendEndpoint,
  onClose,
}: {
  channel: RelayChannel | null;
  backendEndpoint: string;
  onClose: () => void;
}) => {
  if (!channel) {
    return null;
  }

  const configJson = buildPluginConfig(channel, backendEndpoint);

  return (
    <ModalShell title="NODE_CONFIGURATION_FILE" icon={Settings} onClose={onClose}>
      <div className="p-6 font-mono text-xs bg-black/40 relative group overflow-y-auto">
        <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyBtn text={configJson} />
        </div>
        <div className="space-y-1 text-cyan-600 mb-4">
          <div>
            // Relay backend endpoint: <span className="text-fuchsia-400">{backendEndpoint}</span>
          </div>
          <div>
            // Channel: <span className="text-fuchsia-400">{channel.channelId}</span>
          </div>
          <div>
            // Secret: <span className="text-fuchsia-400">{channel.secret}</span>
          </div>
        </div>
        <pre className="text-cyan-300 leading-relaxed overflow-x-auto">{configJson}</pre>
      </div>
    </ModalShell>
  );
};

const UserConnectModal = ({
  user,
  channel,
  relayState,
  onClose,
}: {
  user: RelayUser | null;
  channel: RelayChannel | null;
  relayState: RelayState | null;
  onClose: () => void;
}) => {
  if (!user || !channel) {
    return null;
  }

  const connectionUrl = buildClientConnectUrl(relayState, channel, user);

  return (
    <ModalShell title="CLIENT_CONNECTION_PARAMS" icon={QrCode} accent="fuchsia" onClose={onClose} maxWidth="max-w-lg">
      <div className="p-6 flex flex-col items-center gap-6 bg-black/40 overflow-y-auto">
        <div className="p-4 bg-white rounded-lg shadow-[0_0_30px_rgba(255,255,255,0.1)]">
          <QRCodeImage value={connectionUrl} size={180} />
        </div>

        <div className="w-full space-y-2">
          <div className="flex justify-between items-center">
            <span className="font-mono text-[10px] text-fuchsia-500 tracking-widest">CONNECTION_URL</span>
            <CopyBtn text={connectionUrl} />
          </div>
          <div className="p-3 bg-black/60 border border-fuchsia-900/50 font-mono text-xs text-fuchsia-300 break-all">
            {connectionUrl}
          </div>
        </div>
      </div>
    </ModalShell>
  );
};

const DiagnosticModal = ({
  isOpen,
  isLoading,
  lines,
  onClose,
}: {
  isOpen: boolean;
  isLoading: boolean;
  lines: string[];
  onClose: () => void;
}) => {
  if (!isOpen) {
    return null;
  }

  return (
    <ModalShell title="SYSTEM_DIAGNOSTIC_REPORT" icon={Activity} onClose={onClose}>
      <div className="p-6 overflow-y-auto font-mono text-xs space-y-2 bg-black/40">
        {isLoading ? (
          <div className="flex items-center gap-2 text-cyan-700 animate-pulse">
            <ZapLine />
            <span>QUERYING_RELAY_STATE...</span>
          </div>
        ) : (
          lines.map((line, index) => (
            <div
              key={`${line}-${index}`}
              className={cn(
                'border-l-2 pl-3 py-1',
                line.includes('ERR')
                  ? 'border-rose-500 text-rose-400 bg-rose-500/5'
                  : line.includes('WARN')
                    ? 'border-amber-500 text-amber-400 bg-amber-500/5'
                    : 'border-cyan-800 text-cyan-300/80',
              )}
            >
              <span className="text-cyan-900 mr-2">[{new Date().toLocaleTimeString()}]</span>
              {line}
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
};

const ChannelFormModal = ({
  state,
  onClose,
  onSubmit,
  isSubmitting,
  error,
}: {
  state: ChannelModalState;
  onClose: () => void;
  onSubmit: (values: ChannelFormValues) => Promise<void>;
  isSubmitting: boolean;
  error: string | null;
}) => {
  const [form, setForm] = useState<ChannelFormValues>(() => {
    const generated = randomChannelName();
    return {
      channelId: state?.channel?.channelId ?? generated.id,
      label: state?.channel?.label ?? generated.label,
      secret: state?.channel?.secret ?? randomToken(),
    };
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!state) {
      return;
    }
    const isEdit = state.mode === 'edit';
    const generated = randomChannelName();
    setForm({
      channelId: state.channel?.channelId ?? generated.id,
      label: state.channel?.label ?? generated.label,
      secret: state.channel?.secret ?? randomToken(),
    });
    setShowAdvanced(isEdit);
  }, [state]);

  if (!state) {
    return null;
  }

  const isEditing = state.mode === 'edit';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(form);
  };

  return (
    <ModalShell title={isEditing ? 'EDIT_NODE' : 'REGISTER_NEW_NODE'} icon={Network} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-6 bg-black/40 font-mono text-sm space-y-4 overflow-y-auto">
        <div className="text-[10px] text-cyan-600 tracking-widest">
          {isEditing ? 'MODIFY_EXISTING_CHANNEL' : 'ALL_FIELDS_AUTO_GENERATED — CLICK_ADVANCED_TO_EDIT'}
        </div>
        <div className="flex items-center justify-between px-2 py-1 bg-cyan-950/20 border border-cyan-900/30">
          <div className="text-xs text-cyan-400">
            <span className="text-cyan-700 mr-2">ID:</span>{form.channelId}
            <span className="text-cyan-700 mx-2">|</span>
            <span className="text-cyan-700 mr-2">LABEL:</span>{form.label}
          </div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-[10px] text-cyan-500 hover:text-cyan-300 tracking-widest"
          >
            {showAdvanced ? '[ COLLAPSE ]' : '[ ADVANCED ]'}
          </button>
        </div>

        {showAdvanced && (
          <div className="space-y-4 border-l-2 border-cyan-900/30 pl-4">
            <div className="space-y-2">
              <label className={labelClassName}>CHANNEL_ID</label>
              <input
                value={form.channelId}
                onChange={(event) => setForm((current) => ({ ...current, channelId: event.target.value }))}
                className={inputClassName}
                placeholder="demo-channel"
                disabled={isEditing || isSubmitting}
              />
            </div>
            <div className="space-y-2">
              <label className={labelClassName}>LABEL</label>
              <input
                value={form.label}
                onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
                className={inputClassName}
                placeholder="SG Relay Backend"
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className={labelClassName}>SECRET</label>
                <button
                  type="button"
                  onClick={() => setForm((current) => ({ ...current, secret: randomToken() }))}
                  className="text-[10px] text-cyan-500 hover:text-cyan-300 tracking-widest"
                  disabled={isSubmitting}
                >
                  REGENERATE
                </button>
              </div>
              <input
                value={form.secret}
                onChange={(event) => setForm((current) => ({ ...current, secret: event.target.value }))}
                className={inputClassName}
                disabled={isSubmitting}
              />
            </div>
          </div>
        )}

        {error ? <div className="text-rose-400 text-xs border border-rose-900/40 bg-rose-950/20 px-3 py-2">{error}</div> : null}
        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-cyan-900/50 text-cyan-600 hover:text-cyan-300 hover:border-cyan-700 transition-colors"
            disabled={isSubmitting}
          >
            CANCEL
          </button>
          <button
            type="submit"
            className="px-4 py-2 bg-cyan-950/50 border border-cyan-700 text-cyan-300 hover:bg-cyan-900 hover:text-cyan-100 transition-all disabled:opacity-60"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'SAVING...' : isEditing ? 'UPDATE_NODE' : 'CREATE_NODE'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};

const UserFormModal = ({
  state,
  channel,
  onClose,
  onSubmit,
  isSubmitting,
  error,
}: {
  state: UserModalState;
  channel: RelayChannel | null;
  onClose: () => void;
  onSubmit: (values: UserFormValues) => Promise<void>;
  isSubmitting: boolean;
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
    if (!state) {
      return;
    }
    const isEdit = state.mode === 'edit';
    setForm({
      senderId: state.user?.senderId ?? randomSenderId(),
      chatId: state.user?.chatId ?? '',
      token: state.user?.token ?? randomToken(),
      allowAgents: state.user?.allowAgents?.join(', ') ?? '',
      enabled: state.user?.enabled ?? true,
    });
    setShowAdvanced(isEdit);
  }, [state]);

  if (!state || !channel) {
    return null;
  }

  const isEditing = state.mode === 'edit';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(form);
  };

  return (
    <ModalShell title={isEditing ? 'EDIT_USER' : 'ADD_USER_TO_NODE'} icon={Users} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-6 bg-black/40 font-mono text-sm space-y-4 overflow-y-auto">
        <div className="text-[10px] text-cyan-700 tracking-widest">CHANNEL: {channel.channelId}</div>
        <div className="text-[10px] text-cyan-600 tracking-widest">
          {isEditing ? 'MODIFY_EXISTING_USER' : 'ALL_FIELDS_AUTO_GENERATED — CLICK_ADVANCED_TO_EDIT'}
        </div>
        <div className="flex items-center justify-between px-2 py-1 bg-cyan-950/20 border border-cyan-900/30">
          <div className="text-xs text-cyan-400">
            <span className="text-cyan-700 mr-2">ID:</span>{form.senderId}
          </div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-[10px] text-cyan-500 hover:text-cyan-300 tracking-widest"
          >
            {showAdvanced ? '[ COLLAPSE ]' : '[ ADVANCED ]'}
          </button>
        </div>

        {showAdvanced && (
          <div className="space-y-4 border-l-2 border-cyan-900/30 pl-4">
            <div className="space-y-2">
              <label className={labelClassName}>SENDER_ID</label>
              <input
                value={form.senderId}
                onChange={(event) => setForm((current) => ({ ...current, senderId: event.target.value }))}
                className={inputClassName}
                placeholder="usr-web-01"
                disabled={isEditing || isSubmitting}
              />
            </div>
            <div className="space-y-2">
              <label className={labelClassName}>CHAT_ID</label>
              <input
                value={form.chatId}
                onChange={(event) => setForm((current) => ({ ...current, chatId: event.target.value }))}
                className={inputClassName}
                placeholder="optional fixed chat binding"
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className={labelClassName}>TOKEN</label>
                <button
                  type="button"
                  onClick={() => setForm((current) => ({ ...current, token: randomToken() }))}
                  className="text-[10px] text-cyan-500 hover:text-cyan-300 tracking-widest"
                  disabled={isSubmitting}
                >
                  REGENERATE
            </button>
          </div>
          <input
            value={form.token}
            onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))}
            className={inputClassName}
            placeholder="leave blank to let server generate"
            disabled={isSubmitting}
          />
        </div>
        <div className="space-y-2">
          <label className={labelClassName}>ALLOW_AGENTS</label>
          <input
            value={form.allowAgents}
            onChange={(event) => setForm((current) => ({ ...current, allowAgents: event.target.value }))}
            className={inputClassName}
            placeholder="comma separated, blank means all"
            disabled={isSubmitting}
          />
        </div>
        <label className="flex items-center gap-3 text-cyan-300 text-xs tracking-widest">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
            className="accent-cyan-400"
            disabled={isSubmitting}
          />
          USER_ENABLED
        </label>
          </div>
        )}
        {error ? <div className="text-rose-400 text-xs border border-rose-900/40 bg-rose-950/20 px-3 py-2">{error}</div> : null}
        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-cyan-900/50 text-cyan-600 hover:text-cyan-300 hover:border-cyan-700 transition-colors"
            disabled={isSubmitting}
          >
            CANCEL
          </button>
          <button
            type="submit"
            className="px-4 py-2 bg-cyan-950/50 border border-cyan-700 text-cyan-300 hover:bg-cyan-900 hover:text-cyan-100 transition-all disabled:opacity-60"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'SAVING...' : isEditing ? 'UPDATE_USER' : 'CREATE_USER'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};

const LoginScreen = ({
  onLogin,
  initialToken,
  isAuthenticating,
  error,
}: {
  onLogin: (token: string) => Promise<void>;
  initialToken: string;
  isAuthenticating: boolean;
  error: string | null;
}) => {
  const [token, setToken] = useState(initialToken);

  useEffect(() => {
    setToken(initialToken);
  }, [initialToken]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextToken = token.trim();
    if (!nextToken) {
      return;
    }
    await onLogin(nextToken);
  };

  return (
    <div className="min-h-screen bg-[#020617] text-cyan-500 font-mono flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,_#083344_0%,_#020617_100%)] opacity-50" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_20%,transparent_100%)] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md p-8 bg-black/60 border border-cyan-900/50 shadow-[0_0_50px_rgba(6,182,212,0.1)] backdrop-blur-md">
        <div className="flex flex-col items-center mb-8">
          <Hexagon className="w-12 h-12 text-cyan-400 mb-4 animate-[spin_10s_linear_infinite]" />
          <h1 className="text-xl font-bold tracking-widest text-cyan-100">{GATEWAY_NAME}</h1>
          <p className="text-[10px] text-cyan-600 tracking-widest mt-2">SECURE_UPLINK_REQUIRED</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-2">
            <label className="text-[10px] text-cyan-500 tracking-widest">ADMIN_ACCESS_TOKEN</label>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className={inputClassName}
              placeholder="Enter admin token..."
              disabled={isAuthenticating}
            />
          </div>

          {error ? (
            <div className="border border-rose-900/40 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">{error}</div>
          ) : null}

          <button
            type="submit"
            disabled={isAuthenticating || !token.trim()}
            className="w-full py-3 bg-cyan-950/50 border border-cyan-700 text-cyan-300 hover:bg-cyan-900 hover:text-cyan-100 transition-all tracking-widest text-xs flex justify-center items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isAuthenticating ? (
              <>
                <Activity className="w-4 h-4 animate-spin" />
                AUTHENTICATING...
              </>
            ) : (
              <>
                <Lock className="w-4 h-4" />
                INITIATE_HANDSHAKE
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

function ZapLine() {
  return <Activity className="w-4 h-4" />;
}

export default function App() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(Boolean(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)));
  const [authError, setAuthError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [relayState, setRelayState] = useState<RelayState | null>(null);
  const [time, setTime] = useState(new Date().toISOString());
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [configChannelId, setConfigChannelId] = useState<string | null>(null);
  const [qrTarget, setQrTarget] = useState<{ channelId: string; senderId: string } | null>(null);
  const [channelModalState, setChannelModalState] = useState<ChannelModalState>(null);
  const [userModalState, setUserModalState] = useState<UserModalState>(null);
  const [channelFormError, setChannelFormError] = useState<string | null>(null);
  const [userFormError, setUserFormError] = useState<string | null>(null);
  const [isChannelSubmitting, setIsChannelSubmitting] = useState(false);
  const [isUserSubmitting, setIsUserSubmitting] = useState(false);

  const [isDiagOpen, setIsDiagOpen] = useState(false);
  const [isDiagLoading, setIsDiagLoading] = useState(false);
  const [diagLines, setDiagLines] = useState<string[]>([]);

  const selectedChannel = relayState?.channels.find((channel) => channel.channelId === selectedChannelId) ?? null;
  const configChannel = relayState?.channels.find((channel) => channel.channelId === configChannelId) ?? null;
  const qrChannel = relayState?.channels.find((channel) => channel.channelId === qrTarget?.channelId) ?? null;
  const qrUser = qrChannel?.users.find((user) => user.senderId === qrTarget?.senderId) ?? null;

  const refreshState = async (token = authToken, options?: { silent?: boolean; keepAuthError?: boolean }) => {
    if (!token.trim()) {
      setIsAuthenticated(false);
      setRelayState(null);
      return null;
    }

    if (!options?.silent) {
      setIsRefreshing(true);
    }

    try {
      const nextState = await apiFetch<RelayState>('/api/state', token.trim());
      setRelayState(nextState);
      setAuthToken(token.trim());
      setIsAuthenticated(true);
      setDashboardError(null);
      if (!options?.keepAuthError) {
        setAuthError(null);
      }
      localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token.trim());
      return nextState;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
        setAuthToken('');
        setRelayState(null);
        setSelectedChannelId(null);
        setIsAuthenticated(false);
        setAuthError(message);
      } else if (!options?.silent) {
        setDashboardError(message);
      }
      return null;
    } finally {
      if (!options?.silent) {
        setIsRefreshing(false);
      }
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date().toISOString()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!authToken.trim()) {
      setIsAuthenticating(false);
      return;
    }

    void (async () => {
      await refreshState(authToken, { keepAuthError: true });
      setIsAuthenticating(false);
    })();
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !authToken.trim()) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshState(authToken, { silent: true });
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [isAuthenticated, authToken]);

  useEffect(() => {
    const channels = relayState?.channels ?? [];
    if (channels.length === 0) {
      setSelectedChannelId(null);
      return;
    }

    if (!selectedChannelId || !channels.some((channel) => channel.channelId === selectedChannelId)) {
      setSelectedChannelId(channels[0].channelId);
    }
  }, [relayState, selectedChannelId]);

  const handleLogin = async (token: string) => {
    setIsAuthenticating(true);
    setAuthError(null);
    const state = await refreshState(token);
    setIsAuthenticating(false);
    if (!state) {
      setIsAuthenticated(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    setAuthToken('');
    setRelayState(null);
    setSelectedChannelId(null);
    setIsAuthenticated(false);
    setAuthError(null);
    setDashboardError(null);
  };

  const runDiagnostic = async () => {
    setIsDiagOpen(true);
    setIsDiagLoading(true);
    setDiagLines([]);

    try {
      const nextState = await apiFetch<RelayState>('/api/state', authToken);
      setRelayState(nextState);
      setDiagLines(buildDiagnosticLines(nextState));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      setDiagLines([`ERR: ${message.toUpperCase().replace(/\s+/g, '_')}`]);
    } finally {
      setIsDiagLoading(false);
    }
  };

  const submitChannel = async (values: ChannelFormValues) => {
    setIsChannelSubmitting(true);
    setChannelFormError(null);

    try {
      await apiFetch('/api/channels', authToken, {
        method: 'POST',
        body: JSON.stringify({
          channelId: values.channelId.trim(),
          label: values.label.trim() || undefined,
          secret: values.secret.trim() || undefined,
        }),
      });
      setChannelModalState(null);
      await refreshState(authToken, { silent: true });
      setSelectedChannelId(values.channelId.trim());
    } catch (error) {
      setChannelFormError(error instanceof Error ? error.message : 'failed to save channel');
    } finally {
      setIsChannelSubmitting(false);
    }
  };

  const submitUser = async (values: UserFormValues) => {
    if (!selectedChannel) {
      return;
    }

    setIsUserSubmitting(true);
    setUserFormError(null);

    try {
      await apiFetch(`/api/channels/${encodeURIComponent(selectedChannel.channelId)}/users`, authToken, {
        method: 'POST',
        body: JSON.stringify({
          senderId: values.senderId.trim(),
          chatId: values.chatId.trim() || undefined,
          token: values.token.trim() || undefined,
          allowAgents: values.allowAgents.trim()
            ? values.allowAgents
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            : undefined,
          enabled: values.enabled,
        }),
      });
      setUserModalState(null);
      await refreshState(authToken, { silent: true });
    } catch (error) {
      setUserFormError(error instanceof Error ? error.message : 'failed to save user');
    } finally {
      setIsUserSubmitting(false);
    }
  };

  const handleDeleteChannel = async (channel: RelayChannel) => {
    const confirmed = window.confirm(`Delete channel "${channel.channelId}"? This will also disconnect any active backend/client sessions.`);
    if (!confirmed) {
      return;
    }

    try {
      await apiFetch(`/api/channels/${encodeURIComponent(channel.channelId)}`, authToken, {
        method: 'DELETE',
      });
      if (selectedChannelId === channel.channelId) {
        setSelectedChannelId(null);
      }
      await refreshState(authToken, { silent: true });
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'failed to delete channel');
    }
  };

  const handleDeleteUser = async (user: RelayUser) => {
    if (!selectedChannel) {
      return;
    }

    const confirmed = window.confirm(`Delete user "${user.senderId}" from channel "${selectedChannel.channelId}"?`);
    if (!confirmed) {
      return;
    }

    try {
      await apiFetch(
        `/api/channels/${encodeURIComponent(selectedChannel.channelId)}/users/${encodeURIComponent(user.senderId)}`,
        authToken,
        {
          method: 'DELETE',
        },
      );
      await refreshState(authToken, { silent: true });
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'failed to delete user');
    }
  };

  if (!isAuthenticated) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        initialToken={authToken}
        isAuthenticating={isAuthenticating}
        error={authError}
      />
    );
  }

  const gatewayEndpoint = buildGatewayEndpoint(relayState);
  const backendEndpoint = normalizeBaseUrl(relayState?.pluginBackendUrl) || `${httpToWs(window.location.origin)}/backend`;
  const gatewayStatus = relayState && relayState.channels.length > 0 && relayState.stats.backendCount === 0 ? 'DEGRADED' : 'RUNNING';

  return (
    <div className="min-h-screen bg-[#020617] text-slate-300 font-sans overflow-hidden selection:bg-cyan-900 selection:text-cyan-50 relative flex flex-col">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,_#083344_0%,_#020617_100%)] opacity-50" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_20%,transparent_100%)] pointer-events-none" />
      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.1)_50%)] bg-[size:100%_4px] z-50 opacity-20" />

      <header className="relative z-10 border-b border-cyan-900/50 bg-black/50 backdrop-blur-md px-6 py-3 flex justify-between items-center">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 text-cyan-400">
            <Hexagon className="w-6 h-6 animate-[spin_10s_linear_infinite]" />
            <div className="flex flex-col">
              <span className="font-mono text-sm font-bold tracking-widest">{GATEWAY_NAME}</span>
              <span className="font-mono text-[10px] text-cyan-600">SYS.VER.{GATEWAY_VERSION}</span>
            </div>
          </div>
          <div className="h-6 w-px bg-cyan-900/50" />
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_10px_#10b981]" />
            <span className="font-mono text-xs text-emerald-500 tracking-wider">GATEWAY ONLINE</span>
          </div>
        </div>

        <div className="font-mono text-xs text-cyan-600 tracking-widest flex items-center gap-3">
          <button
            onClick={() => void refreshState(authToken)}
            className="px-3 py-1 border border-cyan-800 hover:bg-cyan-950/50 hover:text-cyan-400 transition-all flex items-center gap-2 group"
            disabled={isRefreshing}
          >
            <RefreshCw className={cn('w-3 h-3', isRefreshing && 'animate-spin')} />
            REFRESH
          </button>
          <button
            onClick={runDiagnostic}
            className="px-3 py-1 border border-cyan-800 hover:bg-cyan-950/50 hover:text-cyan-400 transition-all flex items-center gap-2 group"
          >
            <Activity className="w-3 h-3 group-hover:animate-pulse" />
            RUN_DIAGNOSTIC
          </button>
          <button
            onClick={handleLogout}
            className="px-3 py-1 border border-cyan-900/50 text-cyan-700 hover:text-cyan-300 hover:border-cyan-700 transition-all"
          >
            CLEAR_TOKEN
          </button>
          <div className="h-4 w-px bg-cyan-900/50" />
          <span className="text-cyan-400">{time}</span>
        </div>
      </header>

      <DiagnosticModal isOpen={isDiagOpen} isLoading={isDiagLoading} lines={diagLines} onClose={() => setIsDiagOpen(false)} />
      <NodeConfigModal channel={configChannel} backendEndpoint={backendEndpoint} onClose={() => setConfigChannelId(null)} />
      <UserConnectModal user={qrUser} channel={qrChannel} relayState={relayState} onClose={() => setQrTarget(null)} />
      <ChannelFormModal
        state={channelModalState}
        onClose={() => {
          setChannelModalState(null);
          setChannelFormError(null);
        }}
        onSubmit={submitChannel}
        isSubmitting={isChannelSubmitting}
        error={channelFormError}
      />
      <UserFormModal
        state={userModalState}
        channel={selectedChannel}
        onClose={() => {
          setUserModalState(null);
          setUserFormError(null);
        }}
        onSubmit={submitUser}
        isSubmitting={isUserSubmitting}
        error={userFormError}
      />

      <main className="flex-1 relative z-10 p-4 lg:p-6 flex flex-col gap-6 overflow-hidden">
        {dashboardError ? (
          <div className="border border-rose-900/40 bg-rose-950/20 px-4 py-3 font-mono text-xs text-rose-300">{dashboardError}</div>
        ) : null}

        <Panel title="TIER_1 // RELAY_GATEWAY_SERVER" icon={Server} glow className="h-40 shrink-0">
          <div className="flex h-full flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-6">
              <div className="w-16 h-16 rounded-full border-2 border-cyan-400 flex items-center justify-center bg-cyan-950/30 shadow-[0_0_30px_rgba(34,211,238,0.2)] relative">
                <Globe className="w-8 h-8 text-cyan-300" />
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                <span className="font-mono text-2xl font-bold text-cyan-50 tracking-widest">{GATEWAY_NAME}</span>
                <span className="font-mono text-xs text-cyan-500 break-all">{gatewayEndpoint}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-8">
              <div className="flex flex-col items-end">
                <span className="font-mono text-[10px] text-cyan-600 tracking-widest mb-1">CHANNELS</span>
                <span className="font-mono text-3xl text-cyan-400">{relayState?.channels.length ?? 0}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="font-mono text-[10px] text-cyan-600 tracking-widest mb-1">BACKEND_LINKS</span>
                <span className="font-mono text-3xl text-cyan-400">{relayState?.stats.backendCount ?? 0}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="font-mono text-[10px] text-cyan-600 tracking-widest mb-1">LIVE_CLIENTS</span>
                <span className="font-mono text-3xl text-cyan-400">{relayState?.stats.clientCount ?? 0}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="font-mono text-[10px] text-cyan-600 tracking-widest mb-1">GATEWAY_STATUS</span>
                <StatusBadge status={gatewayStatus} />
              </div>
            </div>
          </div>
        </Panel>

        <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">
          <Panel title="TIER_2 // CHANNEL_MANAGEMENT" icon={Network} className="w-full lg:w-1/3 flex flex-col">
            <div className="flex-1 overflow-y-auto space-y-2 pr-2">
              {relayState?.channels.length ? (
                relayState.channels.map((channel) => (
                  <div
                    key={channel.channelId}
                    onClick={() => setSelectedChannelId(channel.channelId)}
                    className={cn(
                      'px-4 py-2.5 border font-mono transition-all cursor-pointer group relative',
                      selectedChannelId === channel.channelId
                        ? 'bg-cyan-950/40 border-cyan-500/50 shadow-[inset_0_0_20px_rgba(6,182,212,0.1)]'
                        : 'bg-black/40 border-cyan-900/30 hover:border-cyan-700/50',
                    )}
                  >
                    {selectedChannelId === channel.channelId ? (
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyan-400 shadow-[0_0_10px_#22d3ee]" />
                    ) : null}

                    <div className="flex justify-between items-center gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            'text-sm font-bold tracking-wider truncate',
                            selectedChannelId === channel.channelId ? 'text-cyan-300' : 'text-slate-300',
                          )}
                        >
                          {channel.label || channel.channelId}
                        </span>
                        <span className="text-[10px] text-cyan-700 shrink-0">{channel.channelId}</span>
                      </div>
                      <StatusBadge status={channel.backendConnected ? 'online' : 'offline'} />
                    </div>

                    <div className="flex items-center gap-4 mt-2 text-[10px] text-cyan-600">
                      <span className="flex items-center gap-1">
                        <Radio className="w-3 h-3" />
                        <span className="text-cyan-300">{channel.clientCount}</span> clients
                      </span>
                      <span><span className="text-cyan-300">{channel.userCount}</span> users</span>
                      <span className="text-cyan-300 truncate">{channel.secretMasked}</span>
                    </div>

                    <div className="flex flex-wrap justify-end gap-2 mt-2">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setChannelModalState({ mode: 'edit', channel });
                          setChannelFormError(null);
                        }}
                        className="px-2 py-0.5 bg-black/30 border border-cyan-900/50 text-[10px] text-cyan-500 hover:text-cyan-100 hover:bg-cyan-950/50 transition-colors flex items-center gap-1"
                      >
                        <Pencil className="w-3 h-3" />
                        EDIT
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfigChannelId(channel.channelId);
                        }}
                        className="px-2 py-0.5 bg-cyan-950/50 border border-cyan-800 text-[10px] text-cyan-400 hover:bg-cyan-900 hover:text-cyan-100 transition-colors flex items-center gap-1"
                      >
                        <Settings className="w-3 h-3" />
                        GEN_CONFIG
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteChannel(channel);
                        }}
                        className="px-2 py-0.5 bg-rose-950/30 border border-rose-900/50 text-[10px] text-rose-400 hover:bg-rose-900/50 hover:text-rose-100 transition-colors flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        DELETE
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-cyan-800 font-mono text-sm">
                  <Database className="w-12 h-12 mb-4 opacity-50" />
                  <span>NO_CHANNELS_REGISTERED</span>
                </div>
              )}
            </div>
            <button
              onClick={() => {
                setChannelModalState({ mode: 'create' });
                setChannelFormError(null);
              }}
              className="mt-4 w-full py-3 border border-dashed border-cyan-800 text-cyan-600 font-mono text-xs hover:bg-cyan-950/30 hover:text-cyan-400 hover:border-cyan-500 transition-all flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" /> REGISTER_NEW_NODE
            </button>
          </Panel>

          <div className="hidden lg:flex flex-col justify-center items-center px-2">
            <ChevronRight className="w-8 h-8 text-cyan-900/50" />
          </div>

          <Panel
            title={`TIER_3 // USER_CONFIGS [ ${selectedChannel?.label || selectedChannel?.channelId || 'NONE'} ]`}
            icon={Users}
            className="w-full lg:w-2/3 flex flex-col"
          >
            <div className="flex-1 overflow-y-auto">
              {!selectedChannel ? (
                <div className="h-full flex flex-col items-center justify-center text-cyan-800 font-mono text-sm">
                  <ShieldAlert className="w-12 h-12 mb-4 opacity-50" />
                  <span>SELECT_A_CHANNEL_TO_VIEW_USERS</span>
                </div>
              ) : selectedChannel.users.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-cyan-800 font-mono text-sm">
                  <Database className="w-12 h-12 mb-4 opacity-50" />
                  <span>NO_USERS_REGISTERED_FOR_THIS_NODE</span>
                </div>
              ) : (
                <table className="w-full text-left font-mono text-sm">
                  <thead>
                    <tr className="text-[10px] text-cyan-700 border-b border-cyan-900/50">
                      <th className="pb-3 font-normal pl-4">SENDER_ID</th>
                      <th className="pb-3 font-normal">TOKEN</th>
                      <th className="pb-3 font-normal">STATUS</th>
                      <th className="pb-3 font-normal">CHAT_ID</th>
                      <th className="pb-3 font-normal text-right pr-4">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cyan-900/20">
                    {selectedChannel.users.map((user) => (
                      <tr key={user.senderId} className="hover:bg-cyan-950/20 transition-colors group">
                        <td className="py-4 pl-4">
                          <div className="flex items-center gap-2">
                            <Lock className="w-3 h-3 text-cyan-600" />
                            <span className="text-cyan-100">{user.senderId}</span>
                          </div>
                        </td>
                        <td className="py-4">
                          <div className="flex items-center gap-2">
                            <span className="text-cyan-500/70 text-xs break-all">{user.token}</span>
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                              <CopyBtn text={user.token} />
                            </div>
                          </div>
                        </td>
                        <td className="py-4">
                          <StatusBadge status={user.enabled ? 'enabled' : 'disabled'} />
                        </td>
                        <td className="py-4 text-cyan-300 text-xs">{user.chatId || '-'}</td>
                        <td className="py-4 pr-4 text-right">
                          <div className="inline-flex flex-wrap justify-end gap-2">
                            <button
                              onClick={() => setQrTarget({ channelId: selectedChannel.channelId, senderId: user.senderId })}
                              className="inline-flex items-center gap-2 px-3 py-1 bg-fuchsia-950/30 border border-fuchsia-900/50 text-[10px] text-fuchsia-400 hover:bg-fuchsia-900/50 hover:text-fuchsia-100 transition-colors"
                            >
                              <QrCode className="w-3 h-3" />
                              GEN_CONNECT
                            </button>
                            <button
                              onClick={() => {
                                setUserModalState({ mode: 'edit', user });
                                setUserFormError(null);
                              }}
                              className="inline-flex items-center gap-2 px-3 py-1 bg-black/30 border border-cyan-900/50 text-[10px] text-cyan-500 hover:text-cyan-100 hover:bg-cyan-950/50 transition-colors"
                            >
                              <Pencil className="w-3 h-3" />
                              EDIT
                            </button>
                            <button
                              onClick={() => void handleDeleteUser(user)}
                              className="inline-flex items-center gap-2 px-3 py-1 bg-rose-950/30 border border-rose-900/50 text-[10px] text-rose-400 hover:bg-rose-900/50 hover:text-rose-100 transition-colors"
                            >
                              <Trash2 className="w-3 h-3" />
                              DELETE
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="mt-4 pt-4 border-t border-cyan-900/30 flex justify-between items-center gap-4">
              <div className="font-mono text-[10px] text-cyan-700 tracking-widest">
                AUTO_REFRESH_INTERVAL: 5S
                <span className="ml-4">LAST_STATE_SYNC: {formatTimestamp(relayState?.timestamp)}</span>
              </div>
              <button
                onClick={() => {
                  setUserModalState({ mode: 'create' });
                  setUserFormError(null);
                }}
                disabled={!selectedChannel}
                className="px-4 py-2 bg-cyan-950/50 border border-cyan-800 text-cyan-400 font-mono text-xs hover:bg-cyan-900 hover:text-cyan-100 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-3 h-3" /> ADD_USER_TO_NODE
              </button>
            </div>
          </Panel>
        </div>
      </main>
    </div>
  );
}

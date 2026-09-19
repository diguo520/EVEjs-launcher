export interface AppInfo {
  name: string;
  version: string;
  repoRoot: string;
  platform: string;
  phase: string;
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  warn?: boolean;
  message: string;
  hint?: string;
}

export interface EnvReport {
  repoRoot: string;
  node: { version: string; ok: boolean };
  checks: CheckItem[];
  passCount: number;
  totalCount: number;
  sys: SysResource;
}

export interface SysResource {
  memRaw: number;
  memGB: number;
  cpuThreads: number;
  level: "ok" | "warn" | "fail";
  message: string;
}

export interface HealthResult {
  game: boolean;
  images: boolean;
  gateway: boolean;
  market: boolean;
}

export interface ServerConfig {
  ports: { game: number; images: number; gateway: number };
  sourceFile: string;
}

export interface ClientConfig {
  clientPath: string;
  clientExe: string;
  caPem: string;
  proxyUrl: string;
  safeGraphics: string;
  safeWindowed: string;
  sourceFile: string;
}

export interface ConfigBundle {
  server: ServerConfig;
  client: ClientConfig;
}

export type ServiceState = "idle" | "checking" | "starting" | "running" | "error" | "stopping";

export interface ServiceInfo {
  id: string;
  name: string;
  state: ServiceState;
  pid?: number;
  message?: string;
}

export interface ServiceActionResult {
  ok: boolean;
  reason: string;
}

/** 任务视图（服务器日志）读取结果 */
export interface ServerLogResult {
  ok: boolean;
  reason?: string;
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  lines: string[];
}

/** 环境初始化状态 */
export interface InitState {
  busy: boolean;
  key: string | null;
  label: string;
  /** 0-100 进度；null 表示不确定进度 */
  progress: number | null;
}

/** 账号管理 */
export interface AccountRole {
  characterId: string;
  characterName: string;
  securityStatus: number | null;
  isk: number;
  skillPoints: number;
  shipName: string;
  shipTypeID: number | null;
  location: {
    stationID: number | null;
    stationName: string;
    solarSystemID: number | null;
    solarSystemName: string;
    worldSpaceID: number | null;
    label: string;
  };
  /** 游戏内肖像 base64 data URL（未上传时为默认肖像） */
  avatar?: string | null;
}

export interface AccountInfo {
  accountKey: string;
  accountId: number;
  isGM: boolean;
  banned: boolean;
  roles: AccountRole[];
}

export interface AccountOpResult {
  ok: boolean;
  data?: AccountInfo[];
  reason?: string;
  output?: string;
}

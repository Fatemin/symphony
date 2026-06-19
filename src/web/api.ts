import type {
  AgentType,
  AskHistory,
  AskMessage,
  AskResponse,
  Event,
  Issue,
  IssueRelation,
  IssueRelationMap,
  IssueRevision,
  IssueTask,
  MarketplaceInstallResult,
  OpsHistoryRow,
  Project,
  ProjectSkill,
  Run,
  Snapshot,
} from '../shared/types';

export type EngineConfig = Record<string, unknown> & {
  enabled: boolean;
  agent: AgentType;
  model: string;
  codex_cli_path: string;
  codex_model: string;
  permission_mode: string;
  wip_limit: number;
  poll_interval_ms: number;
  workspace_root: string;
  phase_timeout_ms: number;
  stall_timeout_ms: number;
  max_turns: number;
  max_attempts: number;
  max_retry_backoff_ms: number;
};

export type ProjectWithIssues = Project & { issues: Issue[] };
export type IssueDetail = Issue & {
  tasks: IssueTask[];
  runs: Run[];
  events: (Event & { cursor: number })[];
  relations: IssueRelationMap;
  revisions: IssueRevision[];
};

export type ProjectRunPhase = 'plan' | 'implement' | 'qa';

export interface ProjectAgentConfig {
  permission_mode?: string;
  max_turns?: number;
  max_turns_by_phase?: Partial<Record<ProjectRunPhase, number>>;
}

export interface ProjectPromptConfig {
  plan?: string;
  implement?: string;
  qa?: string;
}

export interface VerificationCommandConfig {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  on_failure?: 'retry' | 'park';
}

export interface ProjectWorkflowConfig {
  agent: ProjectAgentConfig;
  prompts: ProjectPromptConfig;
  verification: { commands: VerificationCommandConfig[] };
  promotion: {
    mode: 'direct-merge' | 'pull-request';
    base_branch?: string;
    remote: string;
    auto_merge: boolean;
    check_poll_interval_ms: number;
    check_timeout_ms: number;
  };
  commit_guard: {
    enabled: boolean;
    blocked_untracked_globs: string[];
    max_files?: number;
    max_bytes?: number;
    override_limits: boolean;
  };
}

export interface BranchList {
  default_branch: string;
  branches: string[];
}

export interface ApproveOptions {
  target_branch?: string;
  create_branch?: boolean;
  set_default_branch?: boolean;
}

export interface BranchDiff {
  available: boolean;
  base: string;
  branch: string;
  stat: string;
  files: { path: string; status: string }[];
  patch: string;
  truncated: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}
export interface FsBrowse {
  path: string;
  parent: string | null;
  isGitRepo: boolean;
  entries: FsEntry[];
}
export interface FsValidate {
  ok: boolean;
  resolved?: string;
  exists?: boolean;
  isDirectory?: boolean;
  isGitRepo?: boolean;
  warning?: string;
  error?: string;
}

export interface PreviewStatus {
  running: boolean;
  url?: string;
  port?: number;
  command?: string;
  startedAt?: number;
  output?: string;
  error?: string;
}

export type CreateFollowUpIssueInput = Partial<Issue> & {
  title: string;
  include_context?: boolean;
};

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: opts?.body ? { 'content-type': 'application/json', ...opts?.headers } : opts?.headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const body = (data: unknown) => ({ body: JSON.stringify(data) });

export const api = {
  projects: {
    list: () => req<Project[]>('/api/projects'),
    get: (id: string) => req<ProjectWithIssues>(`/api/projects/${id}`),
    branches: (id: string) => req<BranchList>(`/api/projects/${id}/branches`),
    create: (data: Partial<Project>) => req<Project>('/api/projects', { method: 'POST', ...body(data) }),
    update: (id: string, data: Partial<Project>) =>
      req<Project>(`/api/projects/${id}`, { method: 'PATCH', ...body(data) }),
    remove: (id: string) => req<void>(`/api/projects/${id}`, { method: 'DELETE' }),
    ask: (id: string, data: { question: string; history?: AskMessage[]; agent?: AgentType }) =>
      req<AskResponse>(`/api/projects/${id}/ask`, { method: 'POST', ...body(data) }),
    askHistory: (id: string) => req<AskHistory>(`/api/projects/${id}/ask/history`),
    askReset: (id: string) =>
      req<{ ok: boolean }>(`/api/projects/${id}/ask/history`, { method: 'DELETE' }),
    skills: {
      list: (projectId: string) => req<ProjectSkill[]>(`/api/projects/${projectId}/skills`),
      create: (projectId: string, data: Partial<ProjectSkill>) =>
        req<ProjectSkill>(`/api/projects/${projectId}/skills`, { method: 'POST', ...body(data) }),
      import: (projectId: string, url: string) =>
        req<ProjectSkill>(`/api/projects/${projectId}/skills/import`, { method: 'POST', ...body({ url }) }),
      install: (projectId: string, command: string) =>
        req<MarketplaceInstallResult>(`/api/projects/${projectId}/skills/install`, {
          method: 'POST',
          ...body({ command }),
        }),
      update: (projectId: string, skillId: string, data: Partial<ProjectSkill>) =>
        req<ProjectSkill>(`/api/projects/${projectId}/skills/${skillId}`, { method: 'PATCH', ...body(data) }),
      remove: (projectId: string, skillId: string) =>
        req<void>(`/api/projects/${projectId}/skills/${skillId}`, { method: 'DELETE' }),
    },
  },
  issues: {
    list: (projectId?: string) => req<Issue[]>(`/api/issues${projectId ? `?project_id=${projectId}` : ''}`),
    get: (id: string) => req<IssueDetail>(`/api/issues/${id}`),
    create: (data: Partial<Issue> & { project_id: string; title: string }) =>
      req<Issue>('/api/issues', { method: 'POST', ...body(data) }),
    createFollowUp: (sourceId: string, data: CreateFollowUpIssueInput) =>
      req<{ issue: Issue; relation: IssueRelation }>(`/api/issues/${sourceId}/follow-ups`, {
        method: 'POST',
        ...body(data),
      }),
    update: (id: string, data: Partial<Issue>) =>
      req<Issue>(`/api/issues/${id}`, { method: 'PATCH', ...body(data) }),
    remove: (id: string) => req<void>(`/api/issues/${id}`, { method: 'DELETE' }),
    run: (id: string) => req<{ ok: boolean; reason?: string }>(`/api/issues/${id}/run`, { method: 'POST' }),
    diff: (id: string) => req<BranchDiff>(`/api/issues/${id}/diff`),
    approve: (id: string, options?: ApproveOptions) =>
      req<{ ok: boolean; reason?: string; commit?: string; pr_url?: string; merged?: boolean; target_branch?: string }>(
        `/api/issues/${id}/approve`,
        { method: 'POST', ...(options ? body(options) : {}) },
      ),
    requestChanges: (id: string, data: { feedback: string }) =>
      req<{ ok: boolean; reason?: string; round?: number; dispatched?: boolean }>(
        `/api/issues/${id}/request-changes`,
        { method: 'POST', ...body(data) },
      ),
    preview: {
      status: (id: string) => req<PreviewStatus>(`/api/issues/${id}/preview`),
      start: (id: string) => req<PreviewStatus>(`/api/issues/${id}/preview`, { method: 'POST' }),
      stop: (id: string) => req<{ running: false; stopped: boolean }>(`/api/issues/${id}/preview`, { method: 'DELETE' }),
    },
  },
  fs: {
    browse: (path?: string) =>
      req<FsBrowse>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    validate: (path: string) => req<FsValidate>(`/api/fs/validate?path=${encodeURIComponent(path)}`),
  },
  ops: {
    snapshot: () => req<Snapshot>('/api/ops/snapshot'),
    history: (projectId?: string) =>
      req<OpsHistoryRow[]>(`/api/ops/history${projectId ? `?project_id=${projectId}` : ''}`),
    kick: () => req<{ ok: boolean }>('/api/ops/snapshot/kick', { method: 'POST' }),
    getSettings: () => req<EngineConfig>('/api/ops/settings'),
    updateSettings: (data: Partial<EngineConfig>) =>
      req<EngineConfig>('/api/ops/settings', { method: 'PATCH', ...body(data) }),
  },
};

/** Subscribe to an issue's live activity stream. Returns an unsubscribe function. */
export function streamIssue(
  issueId: string,
  since: number,
  onEvent: (event: Event & { cursor: number }) => void,
): () => void {
  const source = new EventSource(`/api/stream/issues/${issueId}?since=${since}`);
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* ignore malformed */
    }
  };
  return () => source.close();
}

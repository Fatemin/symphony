import type {
  Event,
  Issue,
  IssueTask,
  Project,
  Run,
  Snapshot,
} from '../shared/types';

export type EngineConfig = Record<string, unknown> & {
  enabled: boolean;
  model: string;
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
export type IssueDetail = Issue & { tasks: IssueTask[]; runs: Run[]; events: (Event & { cursor: number })[] };

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
    create: (data: Partial<Project>) => req<Project>('/api/projects', { method: 'POST', ...body(data) }),
    update: (id: string, data: Partial<Project>) =>
      req<Project>(`/api/projects/${id}`, { method: 'PATCH', ...body(data) }),
    remove: (id: string) => req<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  },
  issues: {
    list: (projectId?: string) => req<Issue[]>(`/api/issues${projectId ? `?project_id=${projectId}` : ''}`),
    get: (id: string) => req<IssueDetail>(`/api/issues/${id}`),
    create: (data: Partial<Issue> & { project_id: string; title: string }) =>
      req<Issue>('/api/issues', { method: 'POST', ...body(data) }),
    update: (id: string, data: Partial<Issue>) =>
      req<Issue>(`/api/issues/${id}`, { method: 'PATCH', ...body(data) }),
    remove: (id: string) => req<void>(`/api/issues/${id}`, { method: 'DELETE' }),
    run: (id: string) => req<{ ok: boolean; reason?: string }>(`/api/issues/${id}/run`, { method: 'POST' }),
  },
  ops: {
    snapshot: () => req<Snapshot>('/api/ops/snapshot'),
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

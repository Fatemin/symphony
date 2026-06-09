import type { Issue, IssueStatus } from '../../shared/types';
import { getByIds, listAutoCandidates, listByStatuses } from '../repo/issues';

/**
 * The tracker contract the orchestrator depends on (Symphony §11.1). Keeping it an interface
 * means the orchestrator never knows whether issues come from our local DB or, one day, a remote
 * tracker like Linear — only this adapter would change.
 */
export interface Tracker {
  /** Dispatch candidates: active status + auto mode, already priority-sorted. */
  fetchCandidates(): Issue[];
  /** Current rows for specific issue IDs (active-run reconciliation). */
  fetchByIds(ids: string[]): Issue[];
  /** Issues in the given statuses (startup cleanup, etc.). */
  fetchByStatuses(statuses: IssueStatus[]): Issue[];
}

/** Tracker backed by the built-in SQLite issue store. */
export const localTracker: Tracker = {
  fetchCandidates: () => listAutoCandidates(),
  fetchByIds: (ids) => getByIds(ids),
  fetchByStatuses: (statuses) => listByStatuses(statuses),
};

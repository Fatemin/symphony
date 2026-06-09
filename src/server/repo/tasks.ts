import { getDb } from '../db/client';
import { newId } from '../core/keys';
import type { IssueTask, TaskRole, TaskStatus } from '../../shared/types';

interface TaskRow {
  id: string;
  issue_id: string;
  seq: number;
  role: string;
  title: string;
  intent: string | null;
  status: string;
  created_at: string;
}

const mapRow = (r: TaskRow): IssueTask => ({
  ...r,
  role: r.role as TaskRole,
  status: r.status as TaskStatus,
});

export interface NewTask {
  role?: TaskRole;
  title: string;
  intent?: string | null;
}

/** Replace an issue's task checklist wholesale (planner output). */
export function replaceTasks(issueId: string, tasks: NewTask[]): IssueTask[] {
  const db = getDb();
  db.prepare(`DELETE FROM issue_tasks WHERE issue_id = ?`).run(issueId);
  const insert = db.prepare(
    `INSERT INTO issue_tasks (id, issue_id, seq, role, title, intent, status)
     VALUES (?, ?, ?, ?, ?, ?, 'todo')`,
  );
  tasks.forEach((t, i) => {
    insert.run(newId(), issueId, i + 1, t.role ?? 'impl', t.title, t.intent ?? null);
  });
  return listTasks(issueId);
}

export function listTasks(issueId: string): IssueTask[] {
  const rows = getDb()
    .prepare(`SELECT * FROM issue_tasks WHERE issue_id = ? ORDER BY seq ASC`)
    .all(issueId) as unknown as TaskRow[];
  return rows.map(mapRow);
}

export function setTaskStatus(id: string, status: TaskStatus): void {
  getDb().prepare(`UPDATE issue_tasks SET status = ? WHERE id = ?`).run(status, id);
}

export function setAllTaskStatus(issueId: string, status: TaskStatus): void {
  getDb()
    .prepare(`UPDATE issue_tasks SET status = ? WHERE issue_id = ?`)
    .run(status, issueId);
}

// Dev helper: creates a demo project + a few issues so the board isn't empty.
// Run with: npm run seed
import { createProject, listProjects } from '../src/server/repo/projects';
import { createIssue, listIssues } from '../src/server/repo/issues';

function main() {
  const existing = listProjects().find((p) => p.key === 'DEMO');
  const project =
    existing ??
    createProject({
      name: 'Demo Project',
      key: 'DEMO',
      description: 'A scratch project for trying out the orchestrator.',
      // repo_path left null — set it in the UI to a real local git repo to run agents.
    });

  if (listIssues(project.id).length === 0) {
    createIssue({
      project_id: project.id,
      title: 'Add a /health endpoint that returns 200 OK',
      type: 'feature',
      description: 'Expose a simple liveness endpoint.',
      acceptance_criteria: '- GET /health returns HTTP 200\n- Body is {"status":"ok"}',
      priority: 2,
      status: 'todo',
      mode: 'manual',
    });
    createIssue({
      project_id: project.id,
      title: 'Fix off-by-one in pagination',
      type: 'bug',
      description: 'Last page drops the final item.',
      priority: 1,
      status: 'backlog',
    });
  }

  console.log('Seeded project:', project.key, project.id);
  for (const issue of listIssues(project.id)) {
    console.log(`  ${issue.key} [${issue.status}] ${issue.title}`);
  }
}

main();

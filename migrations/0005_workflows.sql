CREATE TABLE IF NOT EXISTS workflow_projects (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES entries(id),
  name TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('ready_to_launch','active','under_contract','closing','closed','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_projects_folder_idx ON workflow_projects(folder_id);
CREATE INDEX IF NOT EXISTS workflow_projects_stage_idx ON workflow_projects(stage,updated_at);
CREATE TABLE IF NOT EXISTS workflow_checklists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES workflow_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
  applicability TEXT NOT NULL DEFAULT 'always',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_checklists_project_idx ON workflow_checklists(project_id);
CREATE TABLE IF NOT EXISTS workflow_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES workflow_projects(id) ON DELETE CASCADE,
  checklist_id TEXT NOT NULL REFERENCES workflow_checklists(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  version_id TEXT NOT NULL REFERENCES versions(id),
  reviewer TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('confirmed','dismissed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_reviews_lookup_idx ON workflow_reviews(project_id,checklist_id,entry_id,created_at);
CREATE TRIGGER IF NOT EXISTS workflow_reviews_immutable_update
BEFORE UPDATE ON workflow_reviews BEGIN SELECT RAISE(ABORT,'Workflow reviews are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workflow_reviews_immutable_delete
BEFORE DELETE ON workflow_reviews BEGIN SELECT RAISE(ABORT,'Workflow reviews are immutable'); END;

CREATE TRIGGER workflow_reviews_identity BEFORE INSERT ON workflow_reviews
WHEN EXISTS(SELECT 1 FROM workflow_reviews WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Review identity already exists'); END;

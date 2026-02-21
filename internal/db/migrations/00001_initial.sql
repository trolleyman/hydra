-- +goose Up
CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_opened DATETIME
);

CREATE TABLE agents (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id),
    name            TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    branch          TEXT NOT NULL,
    worktree_path   TEXT NOT NULL,
    sandbox_id      TEXT,
    sandbox_template TEXT,
    ai_provider     TEXT NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at     DATETIME,
    log_tail        TEXT,
    UNIQUE (project_id, branch)
);

-- +goose Down
DROP TABLE agents;
DROP TABLE projects;

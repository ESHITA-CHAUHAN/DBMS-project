const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const schemaEngine = require("../schema-engine");
const { now, buildEntry } = require("./helpers");

function createSqliteStore() {
  const dataDir = path.join(__dirname, "..", "..", "data");
  const dbPath = path.join(dataDir, "schemaai.db");

  fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  function migrate() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_name TEXT,
        dialect TEXT NOT NULL,
        target_nf TEXT NOT NULL,
        current_score INTEGER,
        current_status TEXT,
        current_version_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model_name TEXT,
        prompt_summary TEXT NOT NULL,
        response_status TEXT NOT NULL,
        latency_ms INTEGER,
        raw_text TEXT,
        notes TEXT,
        rescued INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        generation_event_id INTEGER,
        version_no INTEGER NOT NULL,
        schema_sql TEXT NOT NULL,
        design_notes TEXT,
        validation_score INTEGER,
        validation_status TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (generation_event_id) REFERENCES generation_events(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_versions_project_version
        ON schema_versions(project_id, version_no);

      CREATE TABLE IF NOT EXISTS schema_tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version_id INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        column_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (schema_version_id) REFERENCES schema_versions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS schema_columns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_table_id INTEGER NOT NULL,
        column_name TEXT NOT NULL,
        data_type TEXT NOT NULL,
        is_nullable INTEGER NOT NULL DEFAULT 1,
        is_primary_key INTEGER NOT NULL DEFAULT 0,
        is_foreign_key INTEGER NOT NULL DEFAULT 0,
        is_unique_key INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (schema_table_id) REFERENCES schema_tables(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS schema_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version_id INTEGER NOT NULL,
        child_table TEXT NOT NULL,
        child_column TEXT NOT NULL,
        parent_table TEXT NOT NULL,
        parent_column TEXT NOT NULL,
        FOREIGN KEY (schema_version_id) REFERENCES schema_versions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS validation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version_id INTEGER NOT NULL,
        validator_name TEXT NOT NULL,
        score INTEGER NOT NULL,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        FOREIGN KEY (schema_version_id) REFERENCES schema_versions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS validation_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        validation_run_id INTEGER NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        finding_title TEXT NOT NULL,
        finding_detail TEXT NOT NULL,
        table_name TEXT,
        column_name TEXT,
        FOREIGN KEY (validation_run_id) REFERENCES validation_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS revision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version_id INTEGER NOT NULL,
        change_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (schema_version_id) REFERENCES schema_versions(id) ON DELETE CASCADE
      );
    `);
  }

  function persistSchemaMetadata(schemaVersionId, report) {
    if (!report) return;

    const insertTable = db.prepare(`
      INSERT INTO schema_tables (schema_version_id, table_name, column_count)
      VALUES (?, ?, ?)
    `);
    const insertColumn = db.prepare(`
      INSERT INTO schema_columns (
        schema_table_id, column_name, data_type, is_nullable, is_primary_key, is_foreign_key, is_unique_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRelationship = db.prepare(`
      INSERT INTO schema_relationships (
        schema_version_id, child_table, child_column, parent_table, parent_column
      ) VALUES (?, ?, ?, ?, ?)
    `);

    report.tables.forEach((table) => {
      const tableInfo = insertTable.run(schemaVersionId, table.name, table.columns.length);
      table.columns.forEach((column) => {
        insertColumn.run(
          tableInfo.lastInsertRowid,
          column.name,
          column.type,
          column.nullable ? 1 : 0,
          table.primaryKey.includes(column.name) || column.primaryKey ? 1 : 0,
          column.foreignKey || table.foreignKeys.some((fk) => fk.childColumn === column.name) ? 1 : 0,
          column.unique ? 1 : 0
        );
      });
    });

    report.relationships.forEach((relationship) => {
      insertRelationship.run(
        schemaVersionId,
        relationship.childTable,
        relationship.childColumn,
        relationship.parentTable,
        relationship.parentColumn
      );
    });
  }

  const saveProjectVersionTx = db.transaction((payload) => {
    const timestamp = now();
    let projectId = payload.projectId || null;
    let versionNo = 1;

    if (projectId) {
      const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
      if (!project) throw new Error("Project not found.");
      versionNo = (db.prepare("SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM schema_versions WHERE project_id = ?").get(projectId).maxVersion || 0) + 1;
      db.prepare(`
        UPDATE projects
        SET title = ?, description = ?, provider = ?, model_name = ?, dialect = ?, target_nf = ?, current_score = ?, current_status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        payload.title,
        payload.description,
        payload.provider,
        payload.modelName || null,
        payload.dialect,
        payload.targetNF,
        payload.report?.score ?? null,
        payload.report?.status ?? null,
        timestamp,
        projectId
      );
    } else {
      const projectInfo = db.prepare(`
        INSERT INTO projects (
          title, description, provider, model_name, dialect, target_nf, current_score, current_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payload.title,
        payload.description,
        payload.provider,
        payload.modelName || null,
        payload.dialect,
        payload.targetNF,
        payload.report?.score ?? null,
        payload.report?.status ?? null,
        timestamp,
        timestamp
      );
      projectId = Number(projectInfo.lastInsertRowid);
    }

    let generationEventId = null;
    if (payload.provider) {
      const eventInfo = db.prepare(`
        INSERT INTO generation_events (
          project_id, provider, model_name, prompt_summary, response_status, latency_ms, raw_text, notes, rescued, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        payload.provider,
        payload.modelName || null,
        payload.description,
        payload.report?.status || "saved",
        payload.latencyMs || 0,
        payload.rawText || null,
        payload.notes || null,
        payload.rescued ? 1 : 0,
        timestamp
      );
      generationEventId = Number(eventInfo.lastInsertRowid);
    }

    const versionInfo = db.prepare(`
      INSERT INTO schema_versions (
        project_id, generation_event_id, version_no, schema_sql, design_notes, validation_score, validation_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      generationEventId,
      versionNo,
      payload.sql,
      payload.notes || null,
      payload.report?.score ?? null,
      payload.report?.status ?? null,
      timestamp
    );
    const schemaVersionId = Number(versionInfo.lastInsertRowid);

    const validationRunInfo = db.prepare(`
      INSERT INTO validation_runs (schema_version_id, validator_name, score, status, checked_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      schemaVersionId,
      payload.validatorName || "local-analyzer",
      payload.report?.score ?? 0,
      payload.report?.status ?? "fail",
      timestamp
    );
    const validationRunId = Number(validationRunInfo.lastInsertRowid);

    const insertFinding = db.prepare(`
      INSERT INTO validation_findings (
        validation_run_id, severity, category, finding_title, finding_detail, table_name, column_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    (payload.report?.findings || []).forEach((finding) => {
      insertFinding.run(
        validationRunId,
        finding.severity,
        finding.category,
        finding.title,
        finding.detail,
        finding.tableName || null,
        finding.columnName || null
      );
    });

    persistSchemaMetadata(schemaVersionId, payload.report);

    db.prepare(`
      INSERT INTO revision_events (schema_version_id, change_summary, created_at)
      VALUES (?, ?, ?)
    `).run(
      schemaVersionId,
      payload.changeSummary || (versionNo === 1 ? "Initial saved schema" : "Saved schema revision"),
      timestamp
    );

    db.prepare("UPDATE projects SET current_version_id = ? WHERE id = ?").run(schemaVersionId, projectId);
    return getProject(projectId);
  });

  function listProjects() {
    const rows = db.prepare(`
      SELECT
        p.id,
        p.title,
        p.description,
        p.provider,
        p.model_name,
        p.dialect,
        p.target_nf,
        p.created_at,
        p.updated_at,
        sv.id AS version_id,
        sv.version_no,
        sv.schema_sql,
        sv.design_notes
      FROM projects p
      JOIN schema_versions sv ON sv.id = p.current_version_id
      ORDER BY p.updated_at DESC
    `).all();
    return rows.map(buildEntry);
  }

  function getProject(id) {
    const row = db.prepare(`
      SELECT
        p.id,
        p.title,
        p.description,
        p.provider,
        p.model_name,
        p.dialect,
        p.target_nf,
        p.created_at,
        p.updated_at,
        sv.id AS version_id,
        sv.version_no,
        sv.schema_sql,
        sv.design_notes
      FROM projects p
      JOIN schema_versions sv ON sv.id = p.current_version_id
      WHERE p.id = ?
    `).get(id);
    if (!row) return null;

    const versions = db.prepare(`
      SELECT id, version_no, schema_sql, design_notes, validation_score, validation_status, created_at
      FROM schema_versions
      WHERE project_id = ?
      ORDER BY version_no DESC
    `).all(id);

    return {
      ...buildEntry(row),
      versions: versions.map((version) => ({
        id: Number(version.id),
        versionNo: Number(version.version_no),
        sql: version.schema_sql,
        notes: version.design_notes || "",
        report: schemaEngine.analyzeSql(version.schema_sql, row.dialect || "mysql"),
        createdAt: version.created_at
      }))
    };
  }

  async function init() {
    migrate();
  }

  async function close() {
    db.close();
  }

  async function saveProjectVersion(payload) {
    return saveProjectVersionTx(payload);
  }

  async function clearProjects() {
    db.exec(`
      DELETE FROM revision_events;
      DELETE FROM validation_findings;
      DELETE FROM validation_runs;
      DELETE FROM schema_relationships;
      DELETE FROM schema_columns;
      DELETE FROM schema_tables;
      DELETE FROM schema_versions;
      DELETE FROM generation_events;
      DELETE FROM projects;
    `);
  }

  async function getMetaRows() {
    return {
      stats: {
        projects: db.prepare("SELECT COUNT(*) AS count FROM projects").get().count,
        versions: db.prepare("SELECT COUNT(*) AS count FROM schema_versions").get().count,
        validations: db.prepare("SELECT COUNT(*) AS count FROM validation_runs").get().count
      },
      projects: db.prepare(`
        SELECT id, title, target_nf AS targetNF, dialect, created_at AS createdAt
        FROM projects
        ORDER BY updated_at DESC
        LIMIT 20
      `).all(),
      versions: db.prepare(`
        SELECT id, project_id AS projectId, version_no AS versionNo, validation_score AS score, created_at AS createdAt
        FROM schema_versions
        ORDER BY id DESC
        LIMIT 20
      `).all(),
      validations: db.prepare(`
        SELECT id, schema_version_id AS schemaVersionId, score, status, checked_at AS checkedAt
        FROM validation_runs
        ORDER BY id DESC
        LIMIT 20
      `).all()
    };
  }

  async function getCounts() {
    return {
      projects: db.prepare("SELECT COUNT(*) AS count FROM projects").get().count,
      versions: db.prepare("SELECT COUNT(*) AS count FROM schema_versions").get().count
    };
  }

  return {
    type: "sqlite",
    init,
    close,
    info() {
      return {
        type: "sqlite",
        location: dbPath
      };
    },
    saveProjectVersion,
    listProjects,
    getProject,
    clearProjects,
    getMetaRows,
    getCounts
  };
}

module.exports = createSqliteStore;

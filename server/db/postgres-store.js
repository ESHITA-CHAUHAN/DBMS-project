const { Pool, types } = require("pg");
const schemaEngine = require("../schema-engine");
const { now, buildEntry } = require("./helpers");

types.setTypeParser(20, (value) => Number(value));

function normalizeConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    ["sslmode", "sslcert", "sslkey", "sslrootcert"].forEach((key) => url.searchParams.delete(key));
    return url.toString();
  } catch {
    return connectionString;
  }
}

function shouldUseSsl(rawConnectionString, sslMode) {
  if (sslMode) {
    return ["1", "true", "require", "enabled"].includes(String(sslMode).toLowerCase());
  }
  return /sslmode=require/i.test(rawConnectionString) || process.env.NODE_ENV === "production";
}

function createPostgresStore({ connectionString, sslMode }) {
  const pool = new Pool({
    connectionString: normalizeConnectionString(connectionString),
    ssl: shouldUseSsl(connectionString, sslMode) ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.DATABASE_POOL_MAX || 10)
  });

  async function migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_name TEXT,
        dialect TEXT NOT NULL,
        target_nf TEXT NOT NULL,
        current_score INTEGER,
        current_status TEXT,
        current_version_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generation_events (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model_name TEXT,
        prompt_summary TEXT NOT NULL,
        response_status TEXT NOT NULL,
        latency_ms INTEGER,
        raw_text TEXT,
        notes TEXT,
        rescued BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_versions (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        generation_event_id BIGINT REFERENCES generation_events(id) ON DELETE SET NULL,
        version_no INTEGER NOT NULL,
        schema_sql TEXT NOT NULL,
        design_notes TEXT,
        validation_score INTEGER,
        validation_status TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_versions_project_version
        ON schema_versions(project_id, version_no);

      CREATE TABLE IF NOT EXISTS schema_tables (
        id BIGSERIAL PRIMARY KEY,
        schema_version_id BIGINT NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
        table_name TEXT NOT NULL,
        column_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS schema_columns (
        id BIGSERIAL PRIMARY KEY,
        schema_table_id BIGINT NOT NULL REFERENCES schema_tables(id) ON DELETE CASCADE,
        column_name TEXT NOT NULL,
        data_type TEXT NOT NULL,
        is_nullable BOOLEAN NOT NULL DEFAULT TRUE,
        is_primary_key BOOLEAN NOT NULL DEFAULT FALSE,
        is_foreign_key BOOLEAN NOT NULL DEFAULT FALSE,
        is_unique_key BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS schema_relationships (
        id BIGSERIAL PRIMARY KEY,
        schema_version_id BIGINT NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
        child_table TEXT NOT NULL,
        child_column TEXT NOT NULL,
        parent_table TEXT NOT NULL,
        parent_column TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS validation_runs (
        id BIGSERIAL PRIMARY KEY,
        schema_version_id BIGINT NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
        validator_name TEXT NOT NULL,
        score INTEGER NOT NULL,
        status TEXT NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS validation_findings (
        id BIGSERIAL PRIMARY KEY,
        validation_run_id BIGINT NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        finding_title TEXT NOT NULL,
        finding_detail TEXT NOT NULL,
        table_name TEXT,
        column_name TEXT
      );

      CREATE TABLE IF NOT EXISTS revision_events (
        id BIGSERIAL PRIMARY KEY,
        schema_version_id BIGINT NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
        change_summary TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
    `);
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function persistSchemaMetadata(client, schemaVersionId, report) {
    if (!report) return;

    for (const table of report.tables) {
      const tableResult = await client.query(`
        INSERT INTO schema_tables (schema_version_id, table_name, column_count)
        VALUES ($1, $2, $3)
        RETURNING id
      `, [schemaVersionId, table.name, table.columns.length]);
      const schemaTableId = tableResult.rows[0].id;

      for (const column of table.columns) {
        await client.query(`
          INSERT INTO schema_columns (
            schema_table_id, column_name, data_type, is_nullable, is_primary_key, is_foreign_key, is_unique_key
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          schemaTableId,
          column.name,
          column.type,
          Boolean(column.nullable),
          table.primaryKey.includes(column.name) || Boolean(column.primaryKey),
          Boolean(column.foreignKey || table.foreignKeys.some((fk) => fk.childColumn === column.name)),
          Boolean(column.unique)
        ]);
      }
    }

    for (const relationship of report.relationships) {
      await client.query(`
        INSERT INTO schema_relationships (
          schema_version_id, child_table, child_column, parent_table, parent_column
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        schemaVersionId,
        relationship.childTable,
        relationship.childColumn,
        relationship.parentTable,
        relationship.parentColumn
      ]);
    }
  }

  async function getProject(id, executor = pool) {
    const rowResult = await executor.query(`
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
      WHERE p.id = $1
    `, [id]);
    const row = rowResult.rows[0];
    if (!row) return null;

    const versionsResult = await executor.query(`
      SELECT id, version_no, schema_sql, design_notes, validation_score, validation_status, created_at
      FROM schema_versions
      WHERE project_id = $1
      ORDER BY version_no DESC
    `, [id]);

    return {
      ...buildEntry(row),
      versions: versionsResult.rows.map((version) => ({
        id: Number(version.id),
        versionNo: Number(version.version_no),
        sql: version.schema_sql,
        notes: version.design_notes || "",
        report: schemaEngine.analyzeSql(version.schema_sql, row.dialect || "mysql"),
        createdAt: version.created_at
      }))
    };
  }

  async function listProjects() {
    const result = await pool.query(`
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
    `);
    return result.rows.map(buildEntry);
  }

  async function saveProjectVersion(payload) {
    return withTransaction(async (client) => {
      const timestamp = now();
      let projectId = payload.projectId || null;
      let versionNo = 1;

      if (projectId) {
        const projectResult = await client.query("SELECT id FROM projects WHERE id = $1", [projectId]);
        if (!projectResult.rows[0]) throw new Error("Project not found.");

        const versionResult = await client.query(`
          SELECT COALESCE(MAX(version_no), 0) AS max_version
          FROM schema_versions
          WHERE project_id = $1
        `, [projectId]);
        versionNo = Number(versionResult.rows[0].max_version || 0) + 1;

        await client.query(`
          UPDATE projects
          SET title = $1, description = $2, provider = $3, model_name = $4, dialect = $5, target_nf = $6,
              current_score = $7, current_status = $8, updated_at = $9
          WHERE id = $10
        `, [
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
        ]);
      } else {
        const projectInsert = await client.query(`
          INSERT INTO projects (
            title, description, provider, model_name, dialect, target_nf, current_score, current_status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `, [
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
        ]);
        projectId = Number(projectInsert.rows[0].id);
      }

      let generationEventId = null;
      if (payload.provider) {
        const eventInsert = await client.query(`
          INSERT INTO generation_events (
            project_id, provider, model_name, prompt_summary, response_status, latency_ms, raw_text, notes, rescued, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `, [
          projectId,
          payload.provider,
          payload.modelName || null,
          payload.description,
          payload.report?.status || "saved",
          Number(payload.latencyMs || 0),
          payload.rawText || null,
          payload.notes || null,
          Boolean(payload.rescued),
          timestamp
        ]);
        generationEventId = Number(eventInsert.rows[0].id);
      }

      const versionInsert = await client.query(`
        INSERT INTO schema_versions (
          project_id, generation_event_id, version_no, schema_sql, design_notes, validation_score, validation_status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `, [
        projectId,
        generationEventId,
        versionNo,
        payload.sql,
        payload.notes || null,
        payload.report?.score ?? null,
        payload.report?.status ?? null,
        timestamp
      ]);
      const schemaVersionId = Number(versionInsert.rows[0].id);

      const validationRunInsert = await client.query(`
        INSERT INTO validation_runs (schema_version_id, validator_name, score, status, checked_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [
        schemaVersionId,
        payload.validatorName || "local-analyzer",
        payload.report?.score ?? 0,
        payload.report?.status ?? "fail",
        timestamp
      ]);
      const validationRunId = Number(validationRunInsert.rows[0].id);

      for (const finding of payload.report?.findings || []) {
        await client.query(`
          INSERT INTO validation_findings (
            validation_run_id, severity, category, finding_title, finding_detail, table_name, column_name
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          validationRunId,
          finding.severity,
          finding.category,
          finding.title,
          finding.detail,
          finding.tableName || null,
          finding.columnName || null
        ]);
      }

      await persistSchemaMetadata(client, schemaVersionId, payload.report);

      await client.query(`
        INSERT INTO revision_events (schema_version_id, change_summary, created_at)
        VALUES ($1, $2, $3)
      `, [
        schemaVersionId,
        payload.changeSummary || (versionNo === 1 ? "Initial saved schema" : "Saved schema revision"),
        timestamp
      ]);

      await client.query("UPDATE projects SET current_version_id = $1 WHERE id = $2", [schemaVersionId, projectId]);
      return getProject(projectId, client);
    });
  }

  async function clearProjects() {
    await pool.query(`
      TRUNCATE TABLE
        revision_events,
        validation_findings,
        validation_runs,
        schema_relationships,
        schema_columns,
        schema_tables,
        schema_versions,
        generation_events,
        projects
      RESTART IDENTITY CASCADE
    `);
  }

  async function getMetaRows() {
    const [statsProjects, statsVersions, statsValidations, projects, versions, validations] = await Promise.all([
      pool.query("SELECT COUNT(*) AS count FROM projects"),
      pool.query("SELECT COUNT(*) AS count FROM schema_versions"),
      pool.query("SELECT COUNT(*) AS count FROM validation_runs"),
      pool.query(`
        SELECT id, title, target_nf AS "targetNF", dialect, created_at AS "createdAt"
        FROM projects
        ORDER BY updated_at DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT id, project_id AS "projectId", version_no AS "versionNo", validation_score AS score, created_at AS "createdAt"
        FROM schema_versions
        ORDER BY id DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT id, schema_version_id AS "schemaVersionId", score, status, checked_at AS "checkedAt"
        FROM validation_runs
        ORDER BY id DESC
        LIMIT 20
      `)
    ]);

    return {
      stats: {
        projects: Number(statsProjects.rows[0].count),
        versions: Number(statsVersions.rows[0].count),
        validations: Number(statsValidations.rows[0].count)
      },
      projects: projects.rows,
      versions: versions.rows,
      validations: validations.rows
    };
  }

  async function getCounts() {
    const [projects, versions] = await Promise.all([
      pool.query("SELECT COUNT(*) AS count FROM projects"),
      pool.query("SELECT COUNT(*) AS count FROM schema_versions")
    ]);

    return {
      projects: Number(projects.rows[0].count),
      versions: Number(versions.rows[0].count)
    };
  }

  async function init() {
    await migrate();
  }

  async function close() {
    await pool.end();
  }

  return {
    type: "postgres",
    init,
    close,
    info() {
      return {
        type: "postgres",
        location: "DATABASE_URL"
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

module.exports = createPostgresStore;

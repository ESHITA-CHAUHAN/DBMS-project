const schemaEngine = require("../schema-engine");

function now() {
  return new Date().toISOString();
}

function buildEntry(row) {
  const report = row.schema_sql ? schemaEngine.analyzeSql(row.schema_sql, row.dialect || "mysql") : null;
  return {
    id: Number(row.id),
    versionId: Number(row.version_id),
    versionNo: Number(row.version_no),
    title: row.title,
    description: row.description,
    sql: row.schema_sql,
    provider: row.provider,
    model: row.model_name,
    dialect: row.dialect,
    targetNF: row.target_nf,
    notes: row.design_notes || "",
    report,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  now,
  buildEntry
};

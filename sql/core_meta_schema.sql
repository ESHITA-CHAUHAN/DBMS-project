-- SchemaAI core meta schema
-- Stores descriptions, generated schemas, revisions, validation reports,
-- normalization evidence, relationship metadata, and AI/API provenance.

CREATE TABLE design_projects (
  project_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(140) NOT NULL,
  description TEXT NOT NULL,
  target_normal_form ENUM('1NF', '2NF', '3NF', 'BCNF') NOT NULL DEFAULT '3NF',
  sql_dialect VARCHAR(40) NOT NULL DEFAULT 'mysql',
  created_by VARCHAR(120) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL
) ENGINE=InnoDB;

CREATE TABLE ai_generation_events (
  event_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(40) NOT NULL,
  model_name VARCHAR(100) NOT NULL,
  prompt_hash CHAR(64) NOT NULL,
  prompt_summary TEXT NOT NULL,
  response_status VARCHAR(40) NOT NULL,
  latency_ms INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_generation_project
    FOREIGN KEY (project_id) REFERENCES design_projects(project_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE schema_versions (
  schema_version_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NULL,
  version_no INT UNSIGNED NOT NULL,
  schema_sql MEDIUMTEXT NOT NULL,
  design_summary TEXT NULL,
  nf_claim ENUM('1NF', '2NF', '3NF', 'BCNF') NOT NULL DEFAULT '3NF',
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_schema_version UNIQUE (project_id, version_no),
  CONSTRAINT fk_schema_version_project
    FOREIGN KEY (project_id) REFERENCES design_projects(project_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_schema_version_event
    FOREIGN KEY (event_id) REFERENCES ai_generation_events(event_id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE schema_tables (
  schema_table_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  schema_version_id BIGINT UNSIGNED NOT NULL,
  table_name VARCHAR(128) NOT NULL,
  purpose TEXT NULL,
  estimated_rows BIGINT UNSIGNED NULL,
  CONSTRAINT uq_schema_table UNIQUE (schema_version_id, table_name),
  CONSTRAINT fk_schema_table_version
    FOREIGN KEY (schema_version_id) REFERENCES schema_versions(schema_version_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE schema_columns (
  schema_column_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  schema_table_id BIGINT UNSIGNED NOT NULL,
  column_name VARCHAR(128) NOT NULL,
  data_type VARCHAR(80) NOT NULL,
  is_nullable BOOLEAN NOT NULL DEFAULT TRUE,
  is_primary_key BOOLEAN NOT NULL DEFAULT FALSE,
  is_foreign_key BOOLEAN NOT NULL DEFAULT FALSE,
  is_unique_key BOOLEAN NOT NULL DEFAULT FALSE,
  column_notes TEXT NULL,
  CONSTRAINT uq_schema_column UNIQUE (schema_table_id, column_name),
  CONSTRAINT fk_schema_column_table
    FOREIGN KEY (schema_table_id) REFERENCES schema_tables(schema_table_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE schema_relationships (
  relationship_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  schema_version_id BIGINT UNSIGNED NOT NULL,
  child_table VARCHAR(128) NOT NULL,
  child_column VARCHAR(128) NOT NULL,
  parent_table VARCHAR(128) NOT NULL,
  parent_column VARCHAR(128) NOT NULL,
  relationship_type VARCHAR(40) NOT NULL DEFAULT 'many-to-one',
  on_delete_rule VARCHAR(40) NULL,
  CONSTRAINT fk_relationship_version
    FOREIGN KEY (schema_version_id) REFERENCES schema_versions(schema_version_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE validation_runs (
  validation_run_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  schema_version_id BIGINT UNSIGNED NOT NULL,
  validator_name VARCHAR(80) NOT NULL,
  score TINYINT UNSIGNED NOT NULL,
  status ENUM('pass', 'warning', 'fail') NOT NULL,
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_validation_run_version
    FOREIGN KEY (schema_version_id) REFERENCES schema_versions(schema_version_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE validation_findings (
  finding_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  validation_run_id BIGINT UNSIGNED NOT NULL,
  severity ENUM('ok', 'warning', 'error') NOT NULL,
  category VARCHAR(80) NOT NULL,
  finding_title VARCHAR(160) NOT NULL,
  finding_detail TEXT NOT NULL,
  table_name VARCHAR(128) NULL,
  column_name VARCHAR(128) NULL,
  CONSTRAINT fk_validation_finding_run
    FOREIGN KEY (validation_run_id) REFERENCES validation_runs(validation_run_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE normalization_checks (
  normalization_check_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  schema_version_id BIGINT UNSIGNED NOT NULL,
  normal_form ENUM('1NF', '2NF', '3NF', 'BCNF') NOT NULL,
  evidence TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_normalization_version
    FOREIGN KEY (schema_version_id) REFERENCES schema_versions(schema_version_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE revision_events (
  revision_event_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  schema_version_id BIGINT UNSIGNED NOT NULL,
  editor_name VARCHAR(120) NULL,
  change_summary TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_revision_version
    FOREIGN KEY (schema_version_id) REFERENCES schema_versions(schema_version_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

const STORAGE_KEYS = {
  settings: "schemaai.settings.v3",
  history: "schemaai.history.v3"
};

const PROVIDER_DEFAULTS = {
  demo: "local-rules-v1",
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o-mini",
  gemini: "gemini-1.5-flash"
};

const RESERVED_WORDS = new Set([
  "user", "order", "group", "rank", "select", "table", "index", "key",
  "constraint", "references", "where", "from", "to", "transaction"
]);

const META_SCHEMA_SQL = `-- SchemaAI core meta schema
-- Stores project descriptions, generated schemas, revisions, validation runs,
-- normalization evidence, relationships, and AI/API call provenance.

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
) ENGINE=InnoDB;`;

let state = {
  settings: {},
  history: [],
  currentSql: "",
  currentDescription: "",
  currentReport: null,
  currentProvider: "demo"
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  loadState();
  bindEvents();
  applySettings();
  $("metaSchemaOutput").textContent = META_SCHEMA_SQL;
  renderHistory();
  renderMetaRows();
});

function loadState() {
  state.settings = readJson(STORAGE_KEYS.settings, {
    provider: "demo",
    apiKey: "",
    modelName: PROVIDER_DEFAULTS.demo,
    useLocalReview: true,
    dialect: "mysql",
    targetNF: "3NF"
  });
  state.history = readJson(STORAGE_KEYS.history, []);
}

function bindEvents() {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.querySelectorAll(".prompt-strip button").forEach((button) => {
    button.addEventListener("click", () => {
      $("projectDescription").value = button.dataset.prompt;
      $("projectDescription").focus();
    });
  });

  $("providerSelect").addEventListener("change", () => {
    const provider = $("providerSelect").value;
    $("modelName").value = PROVIDER_DEFAULTS[provider] || "";
    saveSettings();
  });

  ["apiKey", "modelName", "useLocalReview", "sqlDialect", "targetNF"].forEach((id) => {
    $(id).addEventListener("change", saveSettings);
  });

  $("generateButton").addEventListener("click", handleGenerate);
  $("copyGeneratedButton").addEventListener("click", () => copyText(state.currentSql || $("generatedSql").textContent));
  $("exportSqlButton").addEventListener("click", () => downloadText("schemaai-schema.sql", state.currentSql || $("generatedSql").textContent));
  $("saveDesignButton").addEventListener("click", saveCurrentDesign);
  $("loadGeneratedButton").addEventListener("click", loadGeneratedIntoWorkbench);
  $("validateSqlButton").addEventListener("click", validateWorkbenchSql);
  $("formatSqlButton").addEventListener("click", formatWorkbenchSql);
  $("saveRevisionButton").addEventListener("click", saveRevision);
  $("downloadWorkbenchButton").addEventListener("click", () => downloadText("schemaai-workbench.sql", $("sqlEditor").value));
  $("normalizeButton").addEventListener("click", runNormalization);
  $("copyNormalButton").addEventListener("click", () => copyText($("normalReport").innerText));
  $("copyMetaButton").addEventListener("click", () => copyText(META_SCHEMA_SQL));
  $("exportHistoryButton").addEventListener("click", () => downloadText("schemaai-history.json", JSON.stringify(state.history, null, 2)));
  $("clearHistoryButton").addEventListener("click", clearHistory);

  $("historyList").addEventListener("click", (event) => {
    const action = event.target.closest("[data-history-action]");
    if (!action) return;
    const id = Number(action.dataset.id);
    if (action.dataset.historyAction === "load") loadHistoryItem(id);
    if (action.dataset.historyAction === "download") {
      const item = state.history.find((entry) => entry.id === id);
      if (item) downloadText(`${slugify(item.title)}.sql`, item.sql);
    }
  });
}

function applySettings() {
  $("providerSelect").value = state.settings.provider || "demo";
  $("apiKey").value = state.settings.apiKey || "";
  $("modelName").value = state.settings.modelName || PROVIDER_DEFAULTS[$("providerSelect").value];
  $("useLocalReview").checked = state.settings.useLocalReview !== false;
  $("sqlDialect").value = state.settings.dialect || "mysql";
  $("targetNF").value = state.settings.targetNF || "3NF";
}

function saveSettings() {
  const provider = $("providerSelect").value;
  state.settings = {
    provider,
    apiKey: $("apiKey").value.trim(),
    modelName: $("modelName").value.trim() || PROVIDER_DEFAULTS[provider],
    useLocalReview: $("useLocalReview").checked,
    dialect: $("sqlDialect").value,
    targetNF: $("targetNF").value
  };
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

function switchView(view) {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `view-${view}`);
  });
  if (view === "history") renderHistory();
  if (view === "meta") renderMetaRows();
}

async function handleGenerate() {
  const description = $("projectDescription").value.trim();
  if (!description) {
    showToast("Add a project description first.");
    return;
  }

  saveSettings();
  const settings = state.settings;
  const button = $("generateButton");
  setBusy(button, true, "Generating");

  try {
    let generated;
    const started = performance.now();

    if (settings.provider === "demo") {
      generated = buildLocalDesign(description, settings.dialect, settings.targetNF);
    } else {
      const aiText = await callProvider(settings.provider, settings.apiKey, settings.modelName, buildSystemPrompt(settings), description);
      const sql = extractSql(aiText);
      generated = {
        provider: settings.provider,
        model: settings.modelName,
        sql: sql || aiText,
        notes: aiText,
        latencyMs: Math.round(performance.now() - started)
      };
    }

    const report = settings.useLocalReview ? analyzeSql(generated.sql) : null;
    state.currentSql = generated.sql;
    state.currentDescription = description;
    state.currentProvider = generated.provider;
    state.currentReport = report;

    $("generatedSql").textContent = generated.sql;
    $("sqlEditor").value = generated.sql;
    $("designReport").innerHTML = renderGenerationReport(generated, report);
    if (report) {
      $("validationReport").innerHTML = renderValidationReport(report);
      $("validationScore").textContent = `${report.score}/100`;
      renderInspector(report);
    }
    showToast("Schema generated.");
  } catch (error) {
    showToast(error.message);
    $("designReport").innerHTML = `<div class="finding error"><div class="finding-title">Generation failed</div>${escapeHtml(error.message)}</div>`;
  } finally {
    setBusy(button, false, "Generate");
  }
}

function buildSystemPrompt(settings) {
  return `You are a senior database architect helping DBMS students.
Return a practical ${settings.dialect} schema normalized to ${settings.targetNF}.
Use this exact response structure:
1. A concise concept model with entities and relationships.
2. A fenced SQL block marked sql containing only executable DDL.
3. A validation note list explaining primary keys, foreign keys, indexes, and normal form evidence.
Add a meta-schema mindset: descriptions, versions, validation runs, and revision events must be trackable.`;
}

async function callProvider(provider, key, model, systemPrompt, userPrompt) {
  if (!key) throw new Error("Add an API key or use the offline demo engine.");

  if (provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });
    const data = await parseProviderResponse(response);
    return (data.content || []).map((part) => part.text || "").join("");
  }

  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });
    const data = await parseProviderResponse(response);
    return data.choices?.[0]?.message?.content || "";
  }

  if (provider === "gemini") {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\nProject:\n${userPrompt}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 3000 }
      })
    });
    const data = await parseProviderResponse(response);
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  }

  throw new Error("Unsupported provider.");
}

async function parseProviderResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data.error?.message || data.error || data.raw || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return data;
}

function buildLocalDesign(description, dialect, targetNF) {
  const template = chooseTemplate(description);
  const sql = renderTemplateSql(template, dialect);
  const notes = [
    `<h3>Concept Model</h3>`,
    `<p>${escapeHtml(template.summary)}</p>`,
    `<div class="tag-row">${template.tables.map((table) => `<span class="tag">${escapeHtml(table.name)}</span>`).join("")}</div>`,
    `<h3>Relationships</h3>`,
    `<ul>${template.relationships.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
    `<h3>Normal Form Evidence</h3>`,
    `<ul><li>1NF: all generated columns are scalar and repeating groups are placed in child tables.</li><li>2NF: associative tables use full keys for relationship facts.</li><li>${escapeHtml(targetNF)}: descriptive attributes are separated from transactional facts.</li></ul>`
  ].join("");
  return {
    provider: "offline demo engine",
    model: "local-rules-v1",
    sql,
    notes,
    latencyMs: 0
  };
}

function chooseTemplate(description) {
  const text = description.toLowerCase();
  const domains = [
    ["hospital", ["hospital", "doctor", "patient", "prescription", "appointment"], hospitalTemplate],
    ["university", ["university", "student", "course", "grade", "professor", "instructor"], universityTemplate],
    ["ecommerce", ["e-commerce", "ecommerce", "product", "cart", "seller", "shipment"], ecommerceTemplate],
    ["library", ["library", "book", "member", "fine", "reservation"], libraryTemplate],
    ["banking", ["bank", "banking", "account", "loan", "transaction", "branch"], bankingTemplate],
    ["food", ["food", "restaurant", "delivery", "menu", "coupon"], foodTemplate]
  ];
  const match = domains.find(([, words]) => words.some((word) => text.includes(word)));
  return (match ? match[2] : genericTemplate)(description);
}

function idType(dialect) {
  return dialect === "postgres" ? "BIGINT" : "BIGINT UNSIGNED";
}

function pkType(dialect) {
  return dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY";
}

function renderTemplateSql(template, dialect) {
  const blocks = template.tables.map((table) => {
    const lines = [`  ${table.pk} ${pkType(dialect)}`];
    table.columns.forEach((column) => {
      lines.push(`  ${column.name} ${column.type} ${column.options}`.trimEnd());
    });
    (table.foreignKeys || []).forEach((fk) => {
      lines.push(`  CONSTRAINT ${fk.name} FOREIGN KEY (${fk.column}) REFERENCES ${fk.refTable}(${fk.refColumn}) ${fk.rule || "ON DELETE RESTRICT ON UPDATE CASCADE"}`);
    });
    (table.uniques || []).forEach((unique) => {
      lines.push(`  CONSTRAINT ${unique.name} UNIQUE (${unique.columns.join(", ")})`);
    });
    const body = lines.map((line, index) => `${line}${index === lines.length - 1 ? "" : ","}`).join("\n");
    const suffix = dialect === "postgres" ? ";" : " ENGINE=InnoDB;";
    return `CREATE TABLE ${table.name} (\n${body}\n)${suffix}`;
  });

  const indexes = template.tables.flatMap((table) => {
    return (table.indexes || []).map((index) => `CREATE INDEX ${index.name} ON ${table.name}(${index.columns.join(", ")});`);
  });

  return [...blocks, ...indexes].join("\n\n");
}

function baseColumns() {
  return [
    { name: "created_at", type: "TIMESTAMP", options: "NOT NULL DEFAULT CURRENT_TIMESTAMP" },
    { name: "updated_at", type: "TIMESTAMP", options: "NULL DEFAULT NULL" }
  ];
}

function hospitalTemplate() {
  const ref = idType($("sqlDialect").value);
  return {
    summary: "A hospital schema separating clinical actors, appointments, prescriptions, billing, and itemized charges.",
    relationships: [
      "departments classify doctors",
      "patients and doctors meet through appointments",
      "appointments can produce prescriptions",
      "bills and bill_items store financial facts separately"
    ],
    tables: [
      {
        name: "departments",
        pk: "department_id",
        columns: [
          { name: "department_name", type: "VARCHAR(120)", options: "NOT NULL UNIQUE" },
          { name: "phone_extension", type: "VARCHAR(20)", options: "NULL" },
          ...baseColumns()
        ]
      },
      {
        name: "patients",
        pk: "patient_id",
        columns: [
          { name: "medical_record_no", type: "VARCHAR(32)", options: "NOT NULL UNIQUE" },
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "date_of_birth", type: "DATE", options: "NOT NULL" },
          { name: "gender", type: "VARCHAR(30)", options: "NULL" },
          { name: "phone", type: "VARCHAR(30)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          ...baseColumns()
        ]
      },
      {
        name: "doctors",
        pk: "doctor_id",
        columns: [
          { name: "department_id", type: ref, options: "NOT NULL" },
          { name: "license_no", type: "VARCHAR(60)", options: "NOT NULL UNIQUE" },
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "specialization", type: "VARCHAR(120)", options: "NOT NULL" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_doctors_department", column: "department_id", refTable: "departments", refColumn: "department_id" }],
        indexes: [{ name: "idx_doctors_department", columns: ["department_id"] }]
      },
      {
        name: "appointments",
        pk: "appointment_id",
        columns: [
          { name: "patient_id", type: ref, options: "NOT NULL" },
          { name: "doctor_id", type: ref, options: "NOT NULL" },
          { name: "scheduled_at", type: "DATETIME", options: "NOT NULL" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'scheduled'" },
          { name: "reason", type: "VARCHAR(255)", options: "NULL" },
          ...baseColumns()
        ],
        foreignKeys: [
          { name: "fk_appointments_patient", column: "patient_id", refTable: "patients", refColumn: "patient_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" },
          { name: "fk_appointments_doctor", column: "doctor_id", refTable: "doctors", refColumn: "doctor_id" }
        ],
        indexes: [
          { name: "idx_appointments_patient", columns: ["patient_id"] },
          { name: "idx_appointments_doctor_time", columns: ["doctor_id", "scheduled_at"] }
        ]
      },
      {
        name: "prescriptions",
        pk: "prescription_id",
        columns: [
          { name: "appointment_id", type: ref, options: "NOT NULL" },
          { name: "medicine_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "dosage", type: "VARCHAR(80)", options: "NOT NULL" },
          { name: "duration_days", type: "INT", options: "NOT NULL" },
          { name: "instructions", type: "VARCHAR(255)", options: "NULL" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_prescriptions_appointment", column: "appointment_id", refTable: "appointments", refColumn: "appointment_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_prescriptions_appointment", columns: ["appointment_id"] }]
      },
      {
        name: "bills",
        pk: "bill_id",
        columns: [
          { name: "patient_id", type: ref, options: "NOT NULL" },
          { name: "bill_date", type: "DATE", options: "NOT NULL" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'unpaid'" },
          { name: "total_amount", type: "DECIMAL(12,2)", options: "NOT NULL DEFAULT 0.00" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_bills_patient", column: "patient_id", refTable: "patients", refColumn: "patient_id" }],
        indexes: [{ name: "idx_bills_patient", columns: ["patient_id"] }]
      },
      {
        name: "bill_items",
        pk: "bill_item_id",
        columns: [
          { name: "bill_id", type: ref, options: "NOT NULL" },
          { name: "description", type: "VARCHAR(180)", options: "NOT NULL" },
          { name: "quantity", type: "INT", options: "NOT NULL DEFAULT 1" },
          { name: "unit_price", type: "DECIMAL(12,2)", options: "NOT NULL" }
        ],
        foreignKeys: [{ name: "fk_bill_items_bill", column: "bill_id", refTable: "bills", refColumn: "bill_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_bill_items_bill", columns: ["bill_id"] }]
      }
    ]
  };
}

function universityTemplate() {
  const ref = idType($("sqlDialect").value);
  return {
    summary: "A university registration schema with departments, users, courses, sections, enrollments, and prerequisites.",
    relationships: [
      "departments own courses and instructors",
      "course_sections connect courses to instructors and terms",
      "enrollments resolve the many-to-many student/course-section relationship",
      "course_prerequisites is a self-referencing course relationship"
    ],
    tables: [
      {
        name: "departments",
        pk: "department_id",
        columns: [
          { name: "department_code", type: "VARCHAR(20)", options: "NOT NULL UNIQUE" },
          { name: "department_name", type: "VARCHAR(120)", options: "NOT NULL UNIQUE" },
          ...baseColumns()
        ]
      },
      {
        name: "students",
        pk: "student_id",
        columns: [
          { name: "department_id", type: ref, options: "NOT NULL" },
          { name: "roll_no", type: "VARCHAR(40)", options: "NOT NULL UNIQUE" },
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          { name: "admission_year", type: "INT", options: "NOT NULL" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_students_department", column: "department_id", refTable: "departments", refColumn: "department_id" }],
        indexes: [{ name: "idx_students_department", columns: ["department_id"] }]
      },
      {
        name: "instructors",
        pk: "instructor_id",
        columns: [
          { name: "department_id", type: ref, options: "NOT NULL" },
          { name: "employee_no", type: "VARCHAR(40)", options: "NOT NULL UNIQUE" },
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_instructors_department", column: "department_id", refTable: "departments", refColumn: "department_id" }],
        indexes: [{ name: "idx_instructors_department", columns: ["department_id"] }]
      },
      {
        name: "courses",
        pk: "course_id",
        columns: [
          { name: "department_id", type: ref, options: "NOT NULL" },
          { name: "course_code", type: "VARCHAR(30)", options: "NOT NULL UNIQUE" },
          { name: "course_title", type: "VARCHAR(160)", options: "NOT NULL" },
          { name: "credits", type: "INT", options: "NOT NULL" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_courses_department", column: "department_id", refTable: "departments", refColumn: "department_id" }],
        indexes: [{ name: "idx_courses_department", columns: ["department_id"] }]
      },
      {
        name: "course_sections",
        pk: "section_id",
        columns: [
          { name: "course_id", type: ref, options: "NOT NULL" },
          { name: "instructor_id", type: ref, options: "NOT NULL" },
          { name: "term_code", type: "VARCHAR(20)", options: "NOT NULL" },
          { name: "capacity", type: "INT", options: "NOT NULL" },
          ...baseColumns()
        ],
        foreignKeys: [
          { name: "fk_sections_course", column: "course_id", refTable: "courses", refColumn: "course_id" },
          { name: "fk_sections_instructor", column: "instructor_id", refTable: "instructors", refColumn: "instructor_id" }
        ],
        uniques: [{ name: "uq_course_section_term", columns: ["course_id", "term_code", "instructor_id"] }],
        indexes: [
          { name: "idx_sections_course", columns: ["course_id"] },
          { name: "idx_sections_instructor", columns: ["instructor_id"] }
        ]
      },
      {
        name: "enrollments",
        pk: "enrollment_id",
        columns: [
          { name: "student_id", type: ref, options: "NOT NULL" },
          { name: "section_id", type: ref, options: "NOT NULL" },
          { name: "enrolled_at", type: "TIMESTAMP", options: "NOT NULL DEFAULT CURRENT_TIMESTAMP" },
          { name: "grade", type: "VARCHAR(5)", options: "NULL" }
        ],
        foreignKeys: [
          { name: "fk_enrollments_student", column: "student_id", refTable: "students", refColumn: "student_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" },
          { name: "fk_enrollments_section", column: "section_id", refTable: "course_sections", refColumn: "section_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }
        ],
        uniques: [{ name: "uq_student_section", columns: ["student_id", "section_id"] }],
        indexes: [
          { name: "idx_enrollments_student", columns: ["student_id"] },
          { name: "idx_enrollments_section", columns: ["section_id"] }
        ]
      },
      {
        name: "course_prerequisites",
        pk: "course_prerequisite_id",
        columns: [
          { name: "course_id", type: ref, options: "NOT NULL" },
          { name: "prerequisite_course_id", type: ref, options: "NOT NULL" }
        ],
        foreignKeys: [
          { name: "fk_prereq_course", column: "course_id", refTable: "courses", refColumn: "course_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" },
          { name: "fk_prereq_required_course", column: "prerequisite_course_id", refTable: "courses", refColumn: "course_id" }
        ],
        uniques: [{ name: "uq_course_prerequisite", columns: ["course_id", "prerequisite_course_id"] }],
        indexes: [{ name: "idx_prereq_required_course", columns: ["prerequisite_course_id"] }]
      }
    ]
  };
}

function ecommerceTemplate() {
  const ref = idType($("sqlDialect").value);
  return {
    summary: "A marketplace schema separating catalog, sellers, customers, orders, payments, shipments, and reviews.",
    relationships: [
      "products belong to sellers and categories",
      "orders belong to customers and split line items into order_items",
      "payments and shipments are one-to-many operational facts",
      "reviews connect customers to purchased products"
    ],
    tables: [
      {
        name: "customers",
        pk: "customer_id",
        columns: [
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          { name: "phone", type: "VARCHAR(30)", options: "NOT NULL" },
          ...baseColumns()
        ]
      },
      {
        name: "sellers",
        pk: "seller_id",
        columns: [
          { name: "seller_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'active'" },
          ...baseColumns()
        ]
      },
      {
        name: "categories",
        pk: "category_id",
        columns: [
          { name: "category_name", type: "VARCHAR(120)", options: "NOT NULL UNIQUE" },
          { name: "parent_category_id", type: ref, options: "NULL" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_categories_parent", column: "parent_category_id", refTable: "categories", refColumn: "category_id", rule: "ON DELETE SET NULL ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_categories_parent", columns: ["parent_category_id"] }]
      },
      {
        name: "products",
        pk: "product_id",
        columns: [
          { name: "seller_id", type: ref, options: "NOT NULL" },
          { name: "category_id", type: ref, options: "NOT NULL" },
          { name: "sku", type: "VARCHAR(60)", options: "NOT NULL UNIQUE" },
          { name: "product_name", type: "VARCHAR(180)", options: "NOT NULL" },
          { name: "unit_price", type: "DECIMAL(12,2)", options: "NOT NULL" },
          { name: "stock_qty", type: "INT", options: "NOT NULL DEFAULT 0" },
          ...baseColumns()
        ],
        foreignKeys: [
          { name: "fk_products_seller", column: "seller_id", refTable: "sellers", refColumn: "seller_id" },
          { name: "fk_products_category", column: "category_id", refTable: "categories", refColumn: "category_id" }
        ],
        indexes: [
          { name: "idx_products_seller", columns: ["seller_id"] },
          { name: "idx_products_category", columns: ["category_id"] }
        ]
      },
      {
        name: "orders",
        pk: "order_id",
        columns: [
          { name: "customer_id", type: ref, options: "NOT NULL" },
          { name: "order_no", type: "VARCHAR(50)", options: "NOT NULL UNIQUE" },
          { name: "order_status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'created'" },
          { name: "order_total", type: "DECIMAL(12,2)", options: "NOT NULL DEFAULT 0.00" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_orders_customer", column: "customer_id", refTable: "customers", refColumn: "customer_id" }],
        indexes: [{ name: "idx_orders_customer", columns: ["customer_id"] }]
      },
      {
        name: "order_items",
        pk: "order_item_id",
        columns: [
          { name: "order_id", type: ref, options: "NOT NULL" },
          { name: "product_id", type: ref, options: "NOT NULL" },
          { name: "quantity", type: "INT", options: "NOT NULL" },
          { name: "unit_price", type: "DECIMAL(12,2)", options: "NOT NULL" }
        ],
        foreignKeys: [
          { name: "fk_order_items_order", column: "order_id", refTable: "orders", refColumn: "order_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" },
          { name: "fk_order_items_product", column: "product_id", refTable: "products", refColumn: "product_id" }
        ],
        uniques: [{ name: "uq_order_product", columns: ["order_id", "product_id"] }],
        indexes: [{ name: "idx_order_items_product", columns: ["product_id"] }]
      },
      {
        name: "payments",
        pk: "payment_id",
        columns: [
          { name: "order_id", type: ref, options: "NOT NULL" },
          { name: "amount", type: "DECIMAL(12,2)", options: "NOT NULL" },
          { name: "method", type: "VARCHAR(40)", options: "NOT NULL" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'pending'" },
          { name: "paid_at", type: "TIMESTAMP", options: "NULL" }
        ],
        foreignKeys: [{ name: "fk_payments_order", column: "order_id", refTable: "orders", refColumn: "order_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_payments_order", columns: ["order_id"] }]
      }
    ]
  };
}

function libraryTemplate() {
  const ref = idType($("sqlDialect").value);
  return {
    summary: "A library schema with catalog records, physical copies, members, loans, reservations, and fines.",
    relationships: [
      "books and authors use a bridge table",
      "book_copies tracks each physical copy",
      "loans connect members to copies over time",
      "fines are separate financial facts tied to loans"
    ],
    tables: [
      {
        name: "members",
        pk: "member_id",
        columns: [
          { name: "member_no", type: "VARCHAR(40)", options: "NOT NULL UNIQUE" },
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          { name: "joined_on", type: "DATE", options: "NOT NULL" },
          ...baseColumns()
        ]
      },
      {
        name: "books",
        pk: "book_id",
        columns: [
          { name: "isbn", type: "VARCHAR(20)", options: "NOT NULL UNIQUE" },
          { name: "title", type: "VARCHAR(220)", options: "NOT NULL" },
          { name: "publisher", type: "VARCHAR(140)", options: "NULL" },
          { name: "published_year", type: "INT", options: "NULL" },
          ...baseColumns()
        ]
      },
      {
        name: "authors",
        pk: "author_id",
        columns: [
          { name: "author_name", type: "VARCHAR(140)", options: "NOT NULL UNIQUE" },
          ...baseColumns()
        ]
      },
      {
        name: "book_authors",
        pk: "book_author_id",
        columns: [
          { name: "book_id", type: ref, options: "NOT NULL" },
          { name: "author_id", type: ref, options: "NOT NULL" }
        ],
        foreignKeys: [
          { name: "fk_book_authors_book", column: "book_id", refTable: "books", refColumn: "book_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" },
          { name: "fk_book_authors_author", column: "author_id", refTable: "authors", refColumn: "author_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }
        ],
        uniques: [{ name: "uq_book_author", columns: ["book_id", "author_id"] }],
        indexes: [{ name: "idx_book_authors_author", columns: ["author_id"] }]
      },
      {
        name: "book_copies",
        pk: "copy_id",
        columns: [
          { name: "book_id", type: ref, options: "NOT NULL" },
          { name: "barcode", type: "VARCHAR(50)", options: "NOT NULL UNIQUE" },
          { name: "copy_status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'available'" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_copies_book", column: "book_id", refTable: "books", refColumn: "book_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_copies_book", columns: ["book_id"] }]
      },
      {
        name: "loans",
        pk: "loan_id",
        columns: [
          { name: "member_id", type: ref, options: "NOT NULL" },
          { name: "copy_id", type: ref, options: "NOT NULL" },
          { name: "issued_on", type: "DATE", options: "NOT NULL" },
          { name: "due_on", type: "DATE", options: "NOT NULL" },
          { name: "returned_on", type: "DATE", options: "NULL" }
        ],
        foreignKeys: [
          { name: "fk_loans_member", column: "member_id", refTable: "members", refColumn: "member_id" },
          { name: "fk_loans_copy", column: "copy_id", refTable: "book_copies", refColumn: "copy_id" }
        ],
        indexes: [
          { name: "idx_loans_member", columns: ["member_id"] },
          { name: "idx_loans_copy", columns: ["copy_id"] }
        ]
      },
      {
        name: "fines",
        pk: "fine_id",
        columns: [
          { name: "loan_id", type: ref, options: "NOT NULL" },
          { name: "amount", type: "DECIMAL(10,2)", options: "NOT NULL" },
          { name: "paid_at", type: "TIMESTAMP", options: "NULL" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'unpaid'" }
        ],
        foreignKeys: [{ name: "fk_fines_loan", column: "loan_id", refTable: "loans", refColumn: "loan_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_fines_loan", columns: ["loan_id"] }]
      }
    ]
  };
}

function bankingTemplate() {
  const ref = idType($("sqlDialect").value);
  return {
    summary: "A banking schema with branch ownership, customer profiles, accounts, transactions, loans, and repayments.",
    relationships: [
      "accounts belong to both branches and customers",
      "transactions preserve account balance movement facts",
      "loans belong to customers and branches",
      "loan_payments keep repayment events separate from loan master data"
    ],
    tables: [
      {
        name: "branches",
        pk: "branch_id",
        columns: [
          { name: "branch_code", type: "VARCHAR(30)", options: "NOT NULL UNIQUE" },
          { name: "branch_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "city", type: "VARCHAR(120)", options: "NOT NULL" },
          ...baseColumns()
        ]
      },
      {
        name: "customers",
        pk: "customer_id",
        columns: [
          { name: "customer_no", type: "VARCHAR(40)", options: "NOT NULL UNIQUE" },
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          { name: "phone", type: "VARCHAR(30)", options: "NOT NULL" },
          ...baseColumns()
        ]
      },
      {
        name: "accounts",
        pk: "account_id",
        columns: [
          { name: "customer_id", type: ref, options: "NOT NULL" },
          { name: "branch_id", type: ref, options: "NOT NULL" },
          { name: "account_no", type: "VARCHAR(40)", options: "NOT NULL UNIQUE" },
          { name: "account_type", type: "VARCHAR(30)", options: "NOT NULL" },
          { name: "current_balance", type: "DECIMAL(14,2)", options: "NOT NULL DEFAULT 0.00" },
          ...baseColumns()
        ],
        foreignKeys: [
          { name: "fk_accounts_customer", column: "customer_id", refTable: "customers", refColumn: "customer_id" },
          { name: "fk_accounts_branch", column: "branch_id", refTable: "branches", refColumn: "branch_id" }
        ],
        indexes: [
          { name: "idx_accounts_customer", columns: ["customer_id"] },
          { name: "idx_accounts_branch", columns: ["branch_id"] }
        ]
      },
      {
        name: "transactions",
        pk: "transaction_id",
        columns: [
          { name: "account_id", type: ref, options: "NOT NULL" },
          { name: "transaction_ref", type: "VARCHAR(80)", options: "NOT NULL UNIQUE" },
          { name: "transaction_type", type: "VARCHAR(30)", options: "NOT NULL" },
          { name: "amount", type: "DECIMAL(14,2)", options: "NOT NULL" },
          { name: "posted_at", type: "TIMESTAMP", options: "NOT NULL DEFAULT CURRENT_TIMESTAMP" }
        ],
        foreignKeys: [{ name: "fk_transactions_account", column: "account_id", refTable: "accounts", refColumn: "account_id" }],
        indexes: [{ name: "idx_transactions_account_posted", columns: ["account_id", "posted_at"] }]
      },
      {
        name: "loans",
        pk: "loan_id",
        columns: [
          { name: "customer_id", type: ref, options: "NOT NULL" },
          { name: "branch_id", type: ref, options: "NOT NULL" },
          { name: "loan_no", type: "VARCHAR(50)", options: "NOT NULL UNIQUE" },
          { name: "principal_amount", type: "DECIMAL(14,2)", options: "NOT NULL" },
          { name: "annual_rate", type: "DECIMAL(5,2)", options: "NOT NULL" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'active'" },
          ...baseColumns()
        ],
        foreignKeys: [
          { name: "fk_loans_customer", column: "customer_id", refTable: "customers", refColumn: "customer_id" },
          { name: "fk_loans_branch", column: "branch_id", refTable: "branches", refColumn: "branch_id" }
        ],
        indexes: [
          { name: "idx_loans_customer", columns: ["customer_id"] },
          { name: "idx_loans_branch", columns: ["branch_id"] }
        ]
      },
      {
        name: "loan_payments",
        pk: "loan_payment_id",
        columns: [
          { name: "loan_id", type: ref, options: "NOT NULL" },
          { name: "paid_on", type: "DATE", options: "NOT NULL" },
          { name: "amount", type: "DECIMAL(14,2)", options: "NOT NULL" },
          { name: "payment_ref", type: "VARCHAR(80)", options: "NOT NULL UNIQUE" }
        ],
        foreignKeys: [{ name: "fk_loan_payments_loan", column: "loan_id", refTable: "loans", refColumn: "loan_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_loan_payments_loan", columns: ["loan_id"] }]
      }
    ]
  };
}

function foodTemplate() {
  const ref = idType($("sqlDialect").value);
  return {
    summary: "A food delivery schema with customers, restaurants, menus, orders, delivery partners, payments, coupons, and ratings.",
    relationships: [
      "restaurants own menu_items",
      "orders belong to customers and restaurants",
      "order_items hold each menu item purchased",
      "deliveries connect orders to delivery partners"
    ],
    tables: [
      {
        name: "customers",
        pk: "customer_id",
        columns: [
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          { name: "phone", type: "VARCHAR(30)", options: "NOT NULL" },
          ...baseColumns()
        ]
      },
      {
        name: "restaurants",
        pk: "restaurant_id",
        columns: [
          { name: "restaurant_name", type: "VARCHAR(160)", options: "NOT NULL" },
          { name: "phone", type: "VARCHAR(30)", options: "NOT NULL" },
          { name: "city", type: "VARCHAR(120)", options: "NOT NULL" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'open'" },
          ...baseColumns()
        ]
      },
      {
        name: "menu_items",
        pk: "menu_item_id",
        columns: [
          { name: "restaurant_id", type: ref, options: "NOT NULL" },
          { name: "item_name", type: "VARCHAR(160)", options: "NOT NULL" },
          { name: "price", type: "DECIMAL(10,2)", options: "NOT NULL" },
          { name: "is_available", type: "BOOLEAN", options: "NOT NULL DEFAULT TRUE" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_menu_items_restaurant", column: "restaurant_id", refTable: "restaurants", refColumn: "restaurant_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_menu_items_restaurant", columns: ["restaurant_id"] }]
      },
      {
        name: "delivery_partners",
        pk: "delivery_partner_id",
        columns: [
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "phone", type: "VARCHAR(30)", options: "NOT NULL UNIQUE" },
          { name: "vehicle_type", type: "VARCHAR(40)", options: "NOT NULL" },
          ...baseColumns()
        ]
      },
      {
        name: "orders",
        pk: "order_id",
        columns: [
          { name: "customer_id", type: ref, options: "NOT NULL" },
          { name: "restaurant_id", type: ref, options: "NOT NULL" },
          { name: "order_no", type: "VARCHAR(50)", options: "NOT NULL UNIQUE" },
          { name: "order_status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'placed'" },
          { name: "total_amount", type: "DECIMAL(10,2)", options: "NOT NULL DEFAULT 0.00" },
          ...baseColumns()
        ],
        foreignKeys: [
          { name: "fk_orders_customer", column: "customer_id", refTable: "customers", refColumn: "customer_id" },
          { name: "fk_orders_restaurant", column: "restaurant_id", refTable: "restaurants", refColumn: "restaurant_id" }
        ],
        indexes: [
          { name: "idx_orders_customer", columns: ["customer_id"] },
          { name: "idx_orders_restaurant", columns: ["restaurant_id"] }
        ]
      },
      {
        name: "order_items",
        pk: "order_item_id",
        columns: [
          { name: "order_id", type: ref, options: "NOT NULL" },
          { name: "menu_item_id", type: ref, options: "NOT NULL" },
          { name: "quantity", type: "INT", options: "NOT NULL" },
          { name: "unit_price", type: "DECIMAL(10,2)", options: "NOT NULL" }
        ],
        foreignKeys: [
          { name: "fk_food_order_items_order", column: "order_id", refTable: "orders", refColumn: "order_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" },
          { name: "fk_food_order_items_menu", column: "menu_item_id", refTable: "menu_items", refColumn: "menu_item_id" }
        ],
        uniques: [{ name: "uq_food_order_menu_item", columns: ["order_id", "menu_item_id"] }],
        indexes: [{ name: "idx_food_order_items_menu", columns: ["menu_item_id"] }]
      },
      {
        name: "deliveries",
        pk: "delivery_id",
        columns: [
          { name: "order_id", type: ref, options: "NOT NULL" },
          { name: "delivery_partner_id", type: ref, options: "NOT NULL" },
          { name: "assigned_at", type: "TIMESTAMP", options: "NOT NULL DEFAULT CURRENT_TIMESTAMP" },
          { name: "delivered_at", type: "TIMESTAMP", options: "NULL" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'assigned'" }
        ],
        foreignKeys: [
          { name: "fk_deliveries_order", column: "order_id", refTable: "orders", refColumn: "order_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" },
          { name: "fk_deliveries_partner", column: "delivery_partner_id", refTable: "delivery_partners", refColumn: "delivery_partner_id" }
        ],
        indexes: [
          { name: "idx_deliveries_order", columns: ["order_id"] },
          { name: "idx_deliveries_partner", columns: ["delivery_partner_id"] }
        ]
      }
    ]
  };
}

function genericTemplate(description) {
  const ref = idType($("sqlDialect").value);
  return {
    summary: `A general application schema for: ${description}`,
    relationships: [
      "users own projects",
      "projects contain tasks",
      "activity_logs track auditable events",
      "validation_reports store schema quality evidence"
    ],
    tables: [
      {
        name: "app_users",
        pk: "user_id",
        columns: [
          { name: "full_name", type: "VARCHAR(140)", options: "NOT NULL" },
          { name: "email", type: "VARCHAR(160)", options: "NOT NULL UNIQUE" },
          { name: "role_name", type: "VARCHAR(60)", options: "NOT NULL DEFAULT 'student'" },
          ...baseColumns()
        ]
      },
      {
        name: "projects",
        pk: "project_id",
        columns: [
          { name: "owner_user_id", type: ref, options: "NOT NULL" },
          { name: "project_name", type: "VARCHAR(160)", options: "NOT NULL" },
          { name: "description", type: "TEXT", options: "NULL" },
          { name: "status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'draft'" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_projects_owner", column: "owner_user_id", refTable: "app_users", refColumn: "user_id" }],
        indexes: [{ name: "idx_projects_owner", columns: ["owner_user_id"] }]
      },
      {
        name: "project_tasks",
        pk: "task_id",
        columns: [
          { name: "project_id", type: ref, options: "NOT NULL" },
          { name: "task_title", type: "VARCHAR(180)", options: "NOT NULL" },
          { name: "task_status", type: "VARCHAR(30)", options: "NOT NULL DEFAULT 'open'" },
          { name: "due_on", type: "DATE", options: "NULL" },
          ...baseColumns()
        ],
        foreignKeys: [{ name: "fk_tasks_project", column: "project_id", refTable: "projects", refColumn: "project_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" }],
        indexes: [{ name: "idx_tasks_project", columns: ["project_id"] }]
      },
      {
        name: "activity_logs",
        pk: "activity_log_id",
        columns: [
          { name: "project_id", type: ref, options: "NOT NULL" },
          { name: "actor_user_id", type: ref, options: "NOT NULL" },
          { name: "event_type", type: "VARCHAR(80)", options: "NOT NULL" },
          { name: "event_payload", type: "JSON", options: "NULL" },
          { name: "created_at", type: "TIMESTAMP", options: "NOT NULL DEFAULT CURRENT_TIMESTAMP" }
        ],
        foreignKeys: [
          { name: "fk_logs_project", column: "project_id", refTable: "projects", refColumn: "project_id", rule: "ON DELETE CASCADE ON UPDATE CASCADE" },
          { name: "fk_logs_actor", column: "actor_user_id", refTable: "app_users", refColumn: "user_id" }
        ],
        indexes: [
          { name: "idx_logs_project", columns: ["project_id"] },
          { name: "idx_logs_actor", columns: ["actor_user_id"] }
        ]
      }
    ]
  };
}

function extractSql(text) {
  const fenced = text.match(/```sql\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const createStart = text.search(/CREATE\s+TABLE/i);
  if (createStart >= 0) return text.slice(createStart).trim();
  return "";
}

function analyzeSql(sql) {
  const parsed = parseSql(sql);
  const findings = [];

  if (!sql.trim()) {
    findings.push(finding("error", "Syntax", "No SQL supplied", "Paste or generate CREATE TABLE statements."));
  }
  if (!parsed.tables.length && sql.trim()) {
    findings.push(finding("error", "Syntax", "No CREATE TABLE statements detected", "The analyzer needs DDL with CREATE TABLE blocks."));
  }

  parsed.tables.forEach((table) => {
    if (!table.primaryKey.length) {
      findings.push(finding("error", "Keys", `${table.name} has no primary key`, "Every entity table should have a stable primary key.", table.name));
    }
    if (!table.columns.length) {
      findings.push(finding("error", "Columns", `${table.name} has no parsed columns`, "Check commas and closing parentheses.", table.name));
    }
    table.columns.forEach((column) => {
      const lowerName = column.name.toLowerCase();
      if (RESERVED_WORDS.has(lowerName)) {
        findings.push(finding("warning", "Naming", `${table.name}.${column.name} uses a reserved word`, "Rename or quote reserved identifiers.", table.name, column.name));
      }
      if (/varchar$/i.test(column.type)) {
        findings.push(finding("warning", "Types", `${table.name}.${column.name} has VARCHAR without length`, "Use VARCHAR(n) for predictable storage and validation.", table.name, column.name));
      }
      if (/^decimal$/i.test(column.type)) {
        findings.push(finding("warning", "Types", `${table.name}.${column.name} has DECIMAL without precision`, "Use DECIMAL(p,s) for money and measured values.", table.name, column.name));
      }
      if (/(phone|email|name|amount|status|date|time|type)$/i.test(column.name) && column.nullable && !column.primaryKey) {
        findings.push(finding("warning", "Constraints", `${table.name}.${column.name} is nullable`, "Important descriptive or transactional columns usually need NOT NULL.", table.name, column.name));
      }
      if (/(^|_)(phone|email|address|item|course|author)[0-9]+$/i.test(column.name)) {
        findings.push(finding("warning", "1NF", `${table.name}.${column.name} looks like a repeating group`, "Move repeated facts into a child table.", table.name, column.name));
      }
    });

    if (table.columns.length > 14) {
      findings.push(finding("warning", "3NF", `${table.name} has many columns`, "Large tables often contain multiple concepts that should be separated.", table.name));
    }

    const fkPrefixes = table.foreignKeys
      .map((fk) => fk.childColumn || fk.column)
      .filter(Boolean)
      .map((column) => column.replace(/_id$/i, ""));
    table.columns.forEach((column) => {
      const lower = column.name.toLowerCase();
      const prefix = fkPrefixes.find((item) => lower === `${item.toLowerCase()}_name` || lower === `${item.toLowerCase()}_email`);
      if (prefix) {
        findings.push(finding("warning", "3NF", `${table.name}.${column.name} may duplicate ${prefix} details`, "Keep attributes of referenced entities in their own table.", table.name, column.name));
      }
    });
  });

  parsed.relationships.forEach((rel) => {
    const child = parsed.tableMap.get(rel.childTable.toLowerCase());
    const parent = parsed.tableMap.get(rel.parentTable.toLowerCase());
    if (!child) {
      findings.push(finding("error", "Foreign Keys", `FK references missing child table ${rel.childTable}`, "Check table names."));
      return;
    }
    if (!parent) {
      findings.push(finding("error", "Foreign Keys", `${child.name}.${rel.childColumn} references missing table ${rel.parentTable}`, "Create the parent table before the relationship.", child.name, rel.childColumn));
      return;
    }
    if (!child.columnMap.has(rel.childColumn.toLowerCase())) {
      findings.push(finding("error", "Foreign Keys", `${child.name}.${rel.childColumn} is not a column`, "Add the FK column or fix the constraint.", child.name));
    }
    if (!parent.columnMap.has(rel.parentColumn.toLowerCase())) {
      findings.push(finding("error", "Foreign Keys", `${rel.parentTable}.${rel.parentColumn} is not a column`, "Reference an existing parent key.", parent.name));
    }
    if (!hasIndex(child, rel.childColumn)) {
      findings.push(finding("warning", "Indexes", `${child.name}.${rel.childColumn} has no explicit index`, "Add an index for joins and FK checks.", child.name, rel.childColumn));
    }
  });

  if (parsed.tables.length && !findings.some((item) => item.severity !== "ok")) {
    findings.push(finding("ok", "Validation", "No blocking issues found", "The schema has primary keys, valid relationships, and no obvious normalization smells."));
  }

  const errorCount = findings.filter((item) => item.severity === "error").length;
  const warningCount = findings.filter((item) => item.severity === "warning").length;
  const score = Math.max(0, 100 - errorCount * 22 - warningCount * 6);
  const status = errorCount ? "fail" : warningCount ? "warning" : "pass";

  return {
    tables: parsed.tables,
    relationships: parsed.relationships,
    findings,
    score,
    status,
    summary: {
      tableCount: parsed.tables.length,
      columnCount: parsed.tables.reduce((sum, table) => sum + table.columns.length, 0),
      relationshipCount: parsed.relationships.length,
      errorCount,
      warningCount
    }
  };
}

function finding(severity, category, title, detail, tableName = null, columnName = null) {
  return { severity, category, title, detail, tableName, columnName };
}

function parseSql(sql) {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
  const tables = [];
  const relationships = [];
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_][\w]*)[`"]?\s*\(([\s\S]*?)\)\s*(?:ENGINE\s*=\s*\w+)?\s*;/gi;
  let match;

  while ((match = createRe.exec(withoutComments)) !== null) {
    const table = {
      name: cleanIdentifier(match[1]),
      columns: [],
      columnMap: new Map(),
      primaryKey: [],
      foreignKeys: [],
      indexes: [],
      uniques: []
    };

    splitTopLevel(match[2]).forEach((rawPart) => {
      const part = rawPart.trim().replace(/,$/, "");
      if (!part) return;
      parseTablePart(part, table, relationships);
    });

    table.columns.forEach((column) => table.columnMap.set(column.name.toLowerCase(), column));
    tables.push(table);
  }

  const indexRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+[`"]?([A-Za-z_][\w]*)[`"]?\s+ON\s+[`"]?([A-Za-z_][\w]*)[`"]?\s*\(([^)]+)\)\s*;/gi;
  while ((match = indexRe.exec(withoutComments)) !== null) {
    const tableName = cleanIdentifier(match[2]);
    const table = tables.find((item) => item.name.toLowerCase() === tableName.toLowerCase());
    if (table) {
      table.indexes.push({
        name: cleanIdentifier(match[1]),
        columns: parseIdentifierList(match[3])
      });
    }
  }

  const tableMap = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
  return { tables, relationships, tableMap };
}

function parseTablePart(part, table, relationships) {
  const upper = part.toUpperCase();
  if (/^(CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY/.test(upper)) {
    table.primaryKey.push(...parseIdentifierList(part.match(/\(([^)]+)\)/)?.[1] || ""));
    return;
  }

  if (/^(CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY/.test(upper)) {
    const rel = parseForeignKey(part, table.name);
    if (rel) {
      table.foreignKeys.push(rel);
      relationships.push(rel);
    }
    return;
  }

  if (/^(CONSTRAINT\s+\S+\s+)?UNIQUE/.test(upper)) {
    table.uniques.push(parseIdentifierList(part.match(/\(([^)]+)\)/)?.[1] || ""));
    return;
  }

  if (/^(KEY|INDEX)\s+/i.test(part)) {
    const cols = parseIdentifierList(part.match(/\(([^)]+)\)/)?.[1] || "");
    table.indexes.push({ name: part.split(/\s+/)[1] || "inline_index", columns: cols });
    return;
  }

  const column = parseColumn(part);
  if (!column) return;
  if (column.primaryKey) table.primaryKey.push(column.name);

  const inlineRef = part.match(/REFERENCES\s+[`"]?([A-Za-z_][\w]*)[`"]?\s*\(([^)]+)\)/i);
  if (inlineRef) {
    const rel = {
      childTable: table.name,
      childColumn: column.name,
      parentTable: cleanIdentifier(inlineRef[1]),
      parentColumn: parseIdentifierList(inlineRef[2])[0] || "id"
    };
    column.foreignKey = true;
    table.foreignKeys.push(rel);
    relationships.push(rel);
  }

  table.columns.push(column);
}

function parseColumn(part) {
  const match = part.match(/^[`"]?([A-Za-z_][\w]*)[`"]?\s+(.+)$/);
  if (!match) return null;
  const name = cleanIdentifier(match[1]);
  const rest = match[2].trim();
  const type = readSqlType(rest);
  const upper = rest.toUpperCase();
  return {
    name,
    type,
    nullable: !/\bNOT\s+NULL\b/.test(upper) && !/\bPRIMARY\s+KEY\b/.test(upper),
    primaryKey: /\bPRIMARY\s+KEY\b/.test(upper),
    unique: /\bUNIQUE\b/.test(upper),
    foreignKey: /\bREFERENCES\b/.test(upper),
    raw: part
  };
}

function readSqlType(rest) {
  let depth = 0;
  let result = "";
  for (const char of rest) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (/\s/.test(char) && depth === 0) break;
    result += char;
  }
  return result.toUpperCase();
}

function parseForeignKey(part, childTable) {
  const match = part.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+[`"]?([A-Za-z_][\w]*)[`"]?\s*\(([^)]+)\)/i);
  if (!match) return null;
  return {
    childTable,
    childColumn: parseIdentifierList(match[1])[0],
    parentTable: cleanIdentifier(match[2]),
    parentColumn: parseIdentifierList(match[3])[0]
  };
}

function splitTopLevel(text) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if ((char === "'" || char === '"') && prev !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (!quote) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseIdentifierList(text) {
  return text
    .split(",")
    .map((item) => cleanIdentifier(item.trim()))
    .filter(Boolean);
}

function cleanIdentifier(value) {
  return String(value || "").replace(/[`"]/g, "").trim();
}

function hasIndex(table, columnName) {
  const lower = columnName.toLowerCase();
  if (table.primaryKey.some((column) => column.toLowerCase() === lower)) return true;
  if (table.uniques.some((cols) => cols.some((column) => column.toLowerCase() === lower))) return true;
  return table.indexes.some((index) => index.columns.some((column) => column.toLowerCase() === lower));
}

function renderGenerationReport(generated, report) {
  const sections = [
    `<div class="metric-grid">
      <div class="metric"><strong>${escapeHtml(generated.provider)}</strong><span>provider</span></div>
      <div class="metric"><strong>${escapeHtml(String(generated.latencyMs || 0))}</strong><span>latency ms</span></div>
    </div>`,
    generated.notes && generated.notes.includes("<h3>") ? generated.notes : `<h3>AI Notes</h3><p>${escapeHtml(generated.notes || "Generated locally.")}</p>`
  ];
  if (report) sections.push(renderValidationReport(report));
  return sections.join("");
}

function renderValidationReport(report) {
  const metrics = `<div class="metric-grid">
    <div class="metric"><strong>${report.summary.tableCount}</strong><span>tables</span></div>
    <div class="metric"><strong>${report.summary.relationshipCount}</strong><span>foreign keys</span></div>
    <div class="metric"><strong>${report.summary.columnCount}</strong><span>columns</span></div>
    <div class="metric"><strong>${report.score}</strong><span>score</span></div>
  </div>`;
  const findings = report.findings.map((item) => {
    return `<div class="finding ${item.severity}">
      <div class="finding-title">${escapeHtml(item.category)}: ${escapeHtml(item.title)}</div>
      <div>${escapeHtml(item.detail)}</div>
    </div>`;
  }).join("");
  const nf = `<h3>Normal Form Snapshot</h3>
    <div class="tag-row">
      <span class="tag">1NF ${report.findings.some((item) => item.category === "1NF" && item.severity !== "ok") ? "review" : "pass"}</span>
      <span class="tag">2NF ${report.summary.errorCount ? "review" : "pass"}</span>
      <span class="tag">3NF ${report.findings.some((item) => item.category === "3NF" && item.severity !== "ok") ? "review" : "pass"}</span>
    </div>`;
  return `${metrics}<h3>Findings</h3>${findings}${nf}`;
}

function renderInspector(report) {
  $("inspectorStatus").textContent = `${report.score}/100`;
  if (!report.tables.length) {
    $("inspectorBody").innerHTML = `<div class="empty-state">No parsed tables.</div>`;
    return;
  }
  const html = [
    `<div class="metric-grid">
      <div class="metric"><strong>${report.summary.tableCount}</strong><span>tables</span></div>
      <div class="metric"><strong>${report.summary.relationshipCount}</strong><span>refs</span></div>
    </div>`,
    ...report.tables.map((table) => {
      const rows = table.columns.map((column) => {
        const flags = [
          table.primaryKey.includes(column.name) || column.primaryKey ? "PK" : "",
          column.foreignKey || table.foreignKeys.some((fk) => fk.childColumn === column.name) ? "FK" : "",
          column.unique ? "UQ" : "",
          column.nullable ? "" : "NN"
        ].filter(Boolean).map((flag) => `<span class="flag">${flag}</span>`).join("");
        return `<div class="column-row"><span>${escapeHtml(column.name)}</span><span class="column-flags">${flags}</span></div>`;
      }).join("");
      return `<div class="table-block">
        <div class="table-name"><span>${escapeHtml(table.name)}</span><span>${table.columns.length}</span></div>
        ${rows}
      </div>`;
    })
  ].join("");
  $("inspectorBody").innerHTML = html;
}

function validateWorkbenchSql() {
  const sql = $("sqlEditor").value;
  const report = analyzeSql(sql);
  state.currentSql = sql;
  state.currentReport = report;
  $("validationReport").innerHTML = renderValidationReport(report);
  $("validationScore").textContent = `${report.score}/100`;
  renderInspector(report);
  showToast("SQL validation complete.");
}

function loadGeneratedIntoWorkbench() {
  if (!state.currentSql) {
    showToast("Generate a schema first.");
    return;
  }
  $("sqlEditor").value = state.currentSql;
  switchView("workbench");
  showToast("Generated SQL loaded.");
}

function formatWorkbenchSql() {
  const formatted = formatSql($("sqlEditor").value);
  $("sqlEditor").value = formatted;
  showToast("SQL formatted.");
}

function formatSql(sql) {
  return sql
    .replace(/\r\n/g, "\n")
    .split(/;\s*/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`)
    .join("\n\n");
}

function runNormalization() {
  const relation = parseRelation($("relationInput").value);
  const fds = parseFunctionalDependencies($("fdInput").value);
  if (!relation.attributes.length || !fds.length) {
    $("normalReport").innerHTML = `<div class="finding error"><div class="finding-title">Input needed</div>Use a relation like R(A, B, C) and dependencies like A -> B.</div>`;
    return;
  }

  const candidateKey = findCandidateKey(relation.attributes, fds);
  const prime = new Set(candidateKey);
  const partial = fds.filter((fd) => fd.left.every((attr) => candidateKey.includes(attr)) && fd.left.length < candidateKey.length && fd.right.some((attr) => !prime.has(attr)));
  const transitive = fds.filter((fd) => !isSuperKey(fd.left, relation.attributes, fds) && fd.right.some((attr) => !prime.has(attr)));
  const tables = buildDecomposition(relation.name, candidateKey, fds);

  const tableTags = tables.map((table) => `<span class="tag">${escapeHtml(table.name)}(${table.columns.map(escapeHtml).join(", ")})</span>`).join("");
  const sql = tables.map((table) => renderNormalizedTable(table)).join("\n\n");

  $("normalReport").innerHTML = `
    <div class="metric-grid">
      <div class="metric"><strong>${escapeHtml(candidateKey.join(", "))}</strong><span>candidate key</span></div>
      <div class="metric"><strong>${tables.length}</strong><span>3NF tables</span></div>
    </div>
    <h3>1NF</h3>
    <div class="finding ok"><div class="finding-title">Atomic attributes</div>Represent repeating values as rows in child tables.</div>
    <h3>2NF</h3>
    ${partial.length ? partial.map((fd) => `<div class="finding warn"><div class="finding-title">Partial dependency</div>${escapeHtml(fd.left.join(", "))} determines ${escapeHtml(fd.right.join(", "))}.</div>`).join("") : `<div class="finding ok"><div class="finding-title">No partial dependency detected</div>The dependency set does not show a non-key attribute depending on only part of the candidate key.</div>`}
    <h3>3NF</h3>
    ${transitive.length ? transitive.map((fd) => `<div class="finding warn"><div class="finding-title">Transitive dependency</div>${escapeHtml(fd.left.join(", "))} determines ${escapeHtml(fd.right.join(", "))} and should become its own relation.</div>`).join("") : `<div class="finding ok"><div class="finding-title">No transitive dependency detected</div>Every determinant appears to be a key or key-like determinant.</div>`}
    <h3>Decomposition</h3>
    <div class="tag-row">${tableTags}</div>
    <h3>SQL Draft</h3>
    <pre class="code-output">${escapeHtml(sql)}</pre>
  `;
}

function parseRelation(text) {
  const match = text.match(/([A-Za-z_][\w]*)\s*\(([^)]+)\)/);
  if (!match) return { name: "Relation", attributes: [] };
  return {
    name: match[1],
    attributes: parseIdentifierList(match[2])
  };
}

function parseFunctionalDependencies(text) {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [left, right] = line.split(/->|=>/);
    return {
      left: parseIdentifierList(left || ""),
      right: parseIdentifierList(right || "")
    };
  }).filter((fd) => fd.left.length && fd.right.length);
}

function findCandidateKey(attributes, fds) {
  const all = new Set(attributes);
  for (let size = 1; size <= Math.min(3, attributes.length); size += 1) {
    const combos = combinations(attributes, size);
    const found = combos.find((combo) => setEquals(closure(combo, fds), all));
    if (found) return found;
  }
  return attributes.slice(0, Math.min(2, attributes.length));
}

function isSuperKey(attrs, allAttributes, fds) {
  return setEquals(closure(attrs, fds), new Set(allAttributes));
}

function closure(attrs, fds) {
  const result = new Set(attrs);
  let changed = true;
  while (changed) {
    changed = false;
    fds.forEach((fd) => {
      if (fd.left.every((attr) => result.has(attr))) {
        fd.right.forEach((attr) => {
          if (!result.has(attr)) {
            result.add(attr);
            changed = true;
          }
        });
      }
    });
  }
  return result;
}

function combinations(items, size) {
  if (size === 1) return items.map((item) => [item]);
  const result = [];
  items.forEach((item, index) => {
    combinations(items.slice(index + 1), size - 1).forEach((rest) => result.push([item, ...rest]));
  });
  return result;
}

function setEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function buildDecomposition(relationName, candidateKey, fds) {
  const tables = [];
  fds.forEach((fd) => {
    const columns = [...new Set([...fd.left, ...fd.right])];
    tables.push({
      name: tableNameFrom(fd.left, relationName),
      columns,
      pk: fd.left
    });
  });
  const mainColumns = [...new Set([...candidateKey, ...fds.flatMap((fd) => fd.left)])];
  tables.push({ name: `${snakeCase(relationName)}_facts`, columns: mainColumns, pk: candidateKey });
  return dedupeTables(tables);
}

function dedupeTables(tables) {
  const seen = new Set();
  return tables.filter((table) => {
    const key = `${table.name}:${table.columns.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tableNameFrom(attrs, relationName) {
  const first = attrs[0] || relationName;
  return `${snakeCase(first.replace(/ID$/i, "")) || snakeCase(relationName)}_details`;
}

function renderNormalizedTable(table) {
  const lines = table.columns.map((column) => {
    const type = inferType(column);
    const notNull = table.pk.includes(column) ? " NOT NULL" : "";
    return `  ${snakeCase(column)} ${type}${notNull}`;
  });
  lines.push(`  PRIMARY KEY (${table.pk.map(snakeCase).join(", ")})`);
  return `CREATE TABLE ${table.name} (\n${lines.map((line, index) => `${line}${index === lines.length - 1 ? "" : ","}`).join("\n")}\n);`;
}

function inferType(attr) {
  if (/id$/i.test(attr)) return "BIGINT";
  if (/email/i.test(attr)) return "VARCHAR(160)";
  if (/name|title/i.test(attr)) return "VARCHAR(140)";
  if (/date|on$/i.test(attr)) return "DATE";
  if (/grade/i.test(attr)) return "VARCHAR(5)";
  if (/amount|price|total/i.test(attr)) return "DECIMAL(12,2)";
  return "VARCHAR(120)";
}

function saveCurrentDesign() {
  if (!state.currentSql) {
    showToast("Generate a schema before saving.");
    return;
  }
  const title = titleFromDescription(state.currentDescription);
  const entry = {
    id: Date.now(),
    title,
    description: state.currentDescription,
    sql: state.currentSql,
    provider: state.currentProvider,
    dialect: state.settings.dialect,
    targetNF: state.settings.targetNF,
    report: state.currentReport,
    createdAt: new Date().toISOString()
  };
  state.history.unshift(entry);
  state.history = state.history.slice(0, 25);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.history));
  renderHistory();
  renderMetaRows();
  showToast("Design saved to browser meta store.");
}

function saveRevision() {
  const sql = $("sqlEditor").value.trim();
  if (!sql) {
    showToast("Nothing to save.");
    return;
  }
  state.currentSql = sql;
  state.currentReport = analyzeSql(sql);
  saveCurrentDesign();
}

function renderHistory() {
  if (!state.history.length) {
    $("historyList").innerHTML = `<div class="empty-state">No saved schemas yet.</div>`;
    return;
  }
  $("historyList").innerHTML = state.history.map((entry) => {
    const tables = entry.report?.summary?.tableCount || analyzeSql(entry.sql).summary.tableCount;
    const score = entry.report?.score ?? analyzeSql(entry.sql).score;
    return `<article class="history-item">
      <div>
        <div class="history-title">${escapeHtml(entry.title)}</div>
        <div class="history-meta">${tables} tables | ${score}/100 | ${escapeHtml(entry.provider)} | ${new Date(entry.createdAt).toLocaleString()}</div>
      </div>
      <div class="history-actions">
        <button class="ghost-button compact" type="button" data-history-action="load" data-id="${entry.id}">Load</button>
        <button class="ghost-button compact" type="button" data-history-action="download" data-id="${entry.id}">SQL</button>
      </div>
    </article>`;
  }).join("");
}

function loadHistoryItem(id) {
  const entry = state.history.find((item) => item.id === id);
  if (!entry) return;
  state.currentSql = entry.sql;
  state.currentDescription = entry.description;
  state.currentProvider = entry.provider;
  state.currentReport = entry.report || analyzeSql(entry.sql);
  $("projectDescription").value = entry.description;
  $("generatedSql").textContent = entry.sql;
  $("sqlEditor").value = entry.sql;
  $("designReport").innerHTML = renderGenerationReport({
    provider: entry.provider,
    model: "saved version",
    sql: entry.sql,
    notes: `<h3>Loaded Version</h3><p>${escapeHtml(entry.title)}</p>`,
    latencyMs: 0
  }, state.currentReport);
  $("validationReport").innerHTML = renderValidationReport(state.currentReport);
  $("validationScore").textContent = `${state.currentReport.score}/100`;
  renderInspector(state.currentReport);
  switchView("design");
  showToast("Saved schema loaded.");
}

function clearHistory() {
  if (!confirm("Clear saved schemas from this browser?")) return;
  state.history = [];
  localStorage.removeItem(STORAGE_KEYS.history);
  renderHistory();
  renderMetaRows();
  showToast("History cleared.");
}

function renderMetaRows() {
  if (!state.history.length) {
    $("metaRowsOutput").innerHTML = `<div class="empty-state">No browser rows yet. Saved designs appear as design_projects and schema_versions here.</div>`;
    return;
  }
  $("metaRowsOutput").innerHTML = `
    <h3>design_projects</h3>
    <ul>${state.history.map((entry) => `<li>${entry.id} | ${escapeHtml(entry.title)} | ${escapeHtml(entry.targetNF)} | ${escapeHtml(entry.dialect)}</li>`).join("")}</ul>
    <h3>schema_versions</h3>
    <ul>${state.history.map((entry, index) => `<li>${entry.id}-${index + 1} | ${escapeHtml(entry.title)} | score ${entry.report?.score ?? "n/a"}</li>`).join("")}</ul>
    <h3>validation_runs</h3>
    <ul>${state.history.map((entry) => `<li>${entry.id} | ${entry.report?.status || "saved"} | ${entry.report?.summary?.warningCount || 0} warnings</li>`).join("")}</ul>
  `;
}

function titleFromDescription(description) {
  return description.split(/\s+/).slice(0, 7).join(" ").replace(/[^\w\s-]/g, "") || "Untitled schema";
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "schema";
}

function snakeCase(text) {
  return text
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "")
    .toLowerCase();
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.innerHTML = busy ? `<span aria-hidden="true">...</span>${label}` : `<span aria-hidden="true">${label === "Generate" ? "AI" : "OK"}</span>${label}`;
}

function copyText(text) {
  navigator.clipboard.writeText(text || "").then(() => showToast("Copied."));
}

function downloadText(filename, text) {
  if (!text || text.includes("No schema generated yet")) {
    showToast("Nothing to download yet.");
    return;
  }
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

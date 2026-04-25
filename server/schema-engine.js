const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_SOURCE = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function createElement(id) {
  return {
    id,
    value: id === "sqlDialect" ? "mysql" : "",
    checked: true,
    textContent: "",
    innerHTML: "",
    innerText: "",
    disabled: false,
    style: {},
    addEventListener() {},
    closest() { return null; },
    querySelector() {
      return { innerText: this.innerText || this.textContent || "", textContent: this.textContent || "" };
    },
    classList: { add() {}, remove() {}, toggle() {} }
  };
}

function createRuntime(dialect = "mysql") {
  const elements = new Map();
  const document = {
    addEventListener() {},
    querySelectorAll() { return []; },
    createElement() { return { click() {} }; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      const element = elements.get(id);
      if (id === "sqlDialect") element.value = dialect;
      return element;
    }
  };

  const localData = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance: { now: () => Date.now() },
    fetch,
    Blob,
    URL,
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: {
      getItem(key) { return localData[key] || null; },
      setItem(key, value) { localData[key] = value; },
      removeItem(key) { delete localData[key]; }
    },
    confirm: () => true,
    document,
    window: { clearTimeout, setTimeout },
    module: { exports: {} },
    exports: {}
  };

  vm.createContext(sandbox);
  const script = new vm.Script(`
${APP_SOURCE}
module.exports = {
  META_SCHEMA_SQL,
  buildSystemPrompt,
  buildSchemaRequest,
  callProvider,
  buildLocalDesign,
  extractSql,
  normalizeGeneratedSql,
  analyzeSql,
  shouldRescueGeneration,
  titleFromDescription
};
`);
  script.runInContext(sandbox);
  return sandbox.module.exports;
}

function settingsFor(dialect, targetNF) {
  return { dialect, targetNF };
}

async function generateWithProvider({
  description,
  provider = "demo",
  modelName,
  apiKey,
  dialect = "mysql",
  targetNF = "3NF"
}) {
  const engine = createRuntime(dialect);
  const settings = settingsFor(dialect, targetNF);

  if (provider === "demo") {
    const generated = engine.buildLocalDesign(description, dialect, targetNF);
    const report = engine.analyzeSql(generated.sql);
    return { generated, report, rescued: false };
  }

  const providerResult = await engine.callProvider(
    provider,
    apiKey,
    modelName,
    engine.buildSystemPrompt(settings),
    engine.buildSchemaRequest(settings, description)
  );

  const sql = engine.extractSql(providerResult?.sql || providerResult?.rawText || "");
  if (!sql) {
    throw new Error("The model did not return executable CREATE TABLE SQL.");
  }

  let generated = {
    provider,
    model: modelName,
    sql,
    notes: providerResult?.notes || "",
    rawText: providerResult?.rawText || providerResult?.sql || "",
    latencyMs: providerResult?.latencyMs || 0
  };

  let report = engine.analyzeSql(sql);
  let rescued = false;

  if (engine.shouldRescueGeneration(report)) {
    const rescuedGenerated = engine.buildLocalDesign(description, dialect, targetNF);
    generated = {
      provider: `${provider} + local rescue`,
      model: modelName,
      sql: rescuedGenerated.sql,
      notes: rescuedGenerated.notes,
      rawText: providerResult?.rawText || providerResult?.sql || "",
      latencyMs: providerResult?.latencyMs || 0
    };
    report = engine.analyzeSql(generated.sql);
    rescued = true;
  }

  return { generated, report, rescued };
}

function analyzeSql(sql, dialect = "mysql") {
  const engine = createRuntime(dialect);
  return engine.analyzeSql(sql);
}

function buildLocalDesign(description, dialect = "mysql", targetNF = "3NF") {
  const engine = createRuntime(dialect);
  const generated = engine.buildLocalDesign(description, dialect, targetNF);
  const report = engine.analyzeSql(generated.sql);
  return { generated, report };
}

function makeTitle(description, dialect = "mysql") {
  const engine = createRuntime(dialect);
  return engine.titleFromDescription(description);
}

function getMetaSchemaSql() {
  const engine = createRuntime("mysql");
  return engine.META_SCHEMA_SQL;
}

module.exports = {
  generateWithProvider,
  analyzeSql,
  buildLocalDesign,
  makeTitle,
  getMetaSchemaSql
};

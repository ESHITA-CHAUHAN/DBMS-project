require("dotenv").config();

const path = require("path");
const express = require("express");
const db = require("./server/db");
const schemaEngine = require("./server/schema-engine");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const rootDir = __dirname;

app.use(express.json({ limit: "2mb" }));

const allowedOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.get("origin");
  const allowAnyOrigin = allowedOrigins.includes("*");
  if (origin && (allowAnyOrigin || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", allowAnyOrigin ? "*" : origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

function sendFrontendFile(res, fileName) {
  res.sendFile(path.join(rootDir, fileName));
}

app.get(["/", "/index.html"], (req, res) => {
  sendFrontendFile(res, "index.html");
});

app.get("/app.js", (req, res) => {
  sendFrontendFile(res, "app.js");
});

app.get("/style.css", (req, res) => {
  sendFrontendFile(res, "style.css");
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function resolveApiKey(provider, clientKey) {
  if (clientKey) return clientKey;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY || "";
  if (provider === "openai") return process.env.OPENAI_API_KEY || "";
  if (provider === "gemini") return process.env.GEMINI_API_KEY || "";
  return "";
}

app.get("/api/health", asyncRoute(async (req, res) => {
  const counts = await db.getCounts();
  const info = db.info();
  res.json({
    ok: true,
    backend: true,
    database: info.type,
    location: info.location,
    counts
  });
}));

app.get("/api/meta/schema", (req, res) => {
  res.json({ sql: schemaEngine.getMetaSchemaSql() });
});

app.get("/api/meta/rows", asyncRoute(async (req, res) => {
  res.json(await db.getMetaRows());
}));

app.get("/api/projects", asyncRoute(async (req, res) => {
  res.json({ items: await db.listProjects() });
}));

app.get("/api/projects/:id", asyncRoute(async (req, res) => {
  const project = await db.getProject(Number(req.params.id));
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  res.json(project);
}));

app.delete("/api/projects", asyncRoute(async (req, res) => {
  await db.clearProjects();
  res.json({ ok: true });
}));

app.post("/api/validate", (req, res) => {
  const sql = String(req.body?.sql || "");
  const dialect = String(req.body?.dialect || "mysql");
  const report = schemaEngine.analyzeSql(sql, dialect);
  res.json({ report });
});

app.post("/api/generate", asyncRoute(async (req, res) => {
  const {
    description,
    provider = "demo",
    modelName,
    apiKey,
    dialect = "mysql",
    targetNF = "3NF"
  } = req.body || {};

  if (!String(description || "").trim()) {
    res.status(400).json({ error: "Description is required." });
    return;
  }

  const resolvedKey = resolveApiKey(provider, apiKey);
  const started = Date.now();

  const { generated, report, rescued } = await schemaEngine.generateWithProvider({
    description: String(description).trim(),
    provider,
    modelName,
    apiKey: resolvedKey,
    dialect,
    targetNF
  });

  generated.latencyMs = Date.now() - started;
  res.json({
    generated,
    report,
    rescued
  });
}));

app.post("/api/projects", asyncRoute(async (req, res) => {
  const {
    projectId,
    description,
    sql,
    provider = "demo",
    modelName = "",
    dialect = "mysql",
    targetNF = "3NF",
    notes = "",
    rawText = "",
    latencyMs = 0,
    rescued = false,
    changeSummary
  } = req.body || {};

  if (!String(description || "").trim()) {
    res.status(400).json({ error: "Description is required." });
    return;
  }
  if (!String(sql || "").trim()) {
    res.status(400).json({ error: "SQL is required." });
    return;
  }

  const report = schemaEngine.analyzeSql(String(sql), dialect);
  const saved = await db.saveProjectVersion({
    projectId: projectId ? Number(projectId) : null,
    title: schemaEngine.makeTitle(String(description), dialect),
    description: String(description),
    sql: String(sql),
    provider: String(provider),
    modelName: modelName ? String(modelName) : "",
    dialect: String(dialect),
    targetNF: String(targetNF),
    notes: String(notes || ""),
    rawText: String(rawText || ""),
    latencyMs: Number(latencyMs || 0),
    rescued: Boolean(rescued),
    changeSummary: changeSummary ? String(changeSummary) : undefined,
    report
  });

  res.json(saved);
}));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  const message = error?.message || "Internal server error.";
  res.status(500).json({ error: message });
});

async function startServer() {
  await db.init();
  const dbInfo = db.info();
  app.listen(PORT, () => {
    console.log(`SchemaAI backend running at http://localhost:${PORT}`);
    console.log(`Database: ${dbInfo.type} (${dbInfo.location})`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start SchemaAI backend.");
  console.error(error);
  process.exit(1);
});

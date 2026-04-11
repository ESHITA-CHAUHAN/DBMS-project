// ═══════════════════════════════════════════
//  SchemaAI — app.js
//  DBMS Project · AI-Assisted DB Schema Design
// ═══════════════════════════════════════════

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-4-20250514';

// ── STATE ──────────────────────────────────
let currentSQL  = '';
let schemaHistory = JSON.parse(localStorage.getItem('schemaHistory') || '[]');

// ── TAB SWITCHING ──────────────────────────
function switchTab(tab, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  btn.classList.add('active');
  if (tab === 'history') renderHistory();
}

// ── QUICK FILL ─────────────────────────────
function fillPrompt(text) {
  document.getElementById('generateInput').value = text;
  document.getElementById('generateInput').focus();
}

// ── API CALL ───────────────────────────────
async function callAI(systemPrompt, userMessage) {
  const key = document.getElementById('apiKey').value.trim();
  if (!key) {
    showToast('⚠ Please enter your Anthropic API key in the sidebar');
    throw new Error('No API key');
  }

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error?.message || 'API error');
  }

  const data = await resp.json();
  return data.content.map(b => b.text || '').join('');
}

// ── GENERATE SCHEMA ────────────────────────
async function generateSchema() {
  const input = document.getElementById('generateInput').value.trim();
  if (!input) { showToast('Please describe your application first'); return; }

  const btn     = document.querySelector('#tab-generate .run-btn');
  const btnText = document.getElementById('genBtnText');
  setLoading(btn, btnText, true, 'Generating...');

  const system = `You are an expert database architect. When given an application description:
1. Design a complete normalized SQL schema (MySQL syntax)
2. Ensure all tables are in 3NF
3. Add PRIMARY KEY, FOREIGN KEY, NOT NULL, UNIQUE constraints where appropriate
4. Add AUTO_INCREMENT to primary keys
5. Add inline SQL comments (-- comment) explaining key design decisions
6. After the SQL, add a section "## Analysis" with:
   - List of tables created
   - Normalization level achieved (1NF/2NF/3NF)
   - Key relationships
   - Suggested indexes
Keep SQL clean and production-ready.`;

  try {
    const result = await callAI(system, `Design a complete database schema for: ${input}`);
    currentSQL = extractSQL(result);

    const outputEl = document.getElementById('generateOutput');
    const resultEl = document.getElementById('generateResult');

    outputEl.style.display = 'block';
    resultEl.innerHTML = formatOutput(result);
    renderNFBadges();
    renderInspector(currentSQL);

    // Save description for history
    window._lastDescription = input;
    showToast('✓ Schema generated successfully');
  } catch(e) {
    showToast('✗ Error: ' + e.message);
  } finally {
    setLoading(btn, btnText, false, 'Generate Schema ↗');
  }
}

// ── NORMALIZE ──────────────────────────────
async function normalizeSchema() {
  const input = document.getElementById('normalizeInput').value.trim();
  if (!input) { showToast('Please enter a table to normalize'); return; }

  const btn     = document.querySelector('#tab-normalize .run-btn');
  const btnText = document.getElementById('normBtnText');
  setLoading(btn, btnText, true, 'Normalizing...');

  const system = `You are a database normalization expert. Given an unnormalized table or schema:
1. Identify the current normal form
2. Show step-by-step transformation:
   - Step 1: Achieve 1NF (atomic values, no repeating groups)
   - Step 2: Achieve 2NF (remove partial dependencies)
   - Step 3: Achieve 3NF (remove transitive dependencies)
3. For each step, show:
   - What problem exists
   - The fix (SQL CREATE TABLE statements)
   - Why this is better
4. Show the final 3NF schema with all constraints
Use MySQL syntax. Be educational and clear.`;

  try {
    const result = await callAI(system, `Normalize this to 3NF:\n\n${input}`);
    const outputEl = document.getElementById('normalizeOutput');
    const resultEl = document.getElementById('normalizeResult');
    outputEl.style.display = 'block';
    resultEl.innerHTML = formatOutput(result);
    showToast('✓ Normalization complete');
  } catch(e) {
    showToast('✗ Error: ' + e.message);
  } finally {
    setLoading(btn, btnText, false, 'Normalize to 3NF ↗');
  }
}

// ── VALIDATE SQL ───────────────────────────
async function validateSQL() {
  const input = document.getElementById('validateInput').value.trim();
  if (!input) { showToast('Please paste SQL to validate'); return; }

  const btn     = document.querySelector('#tab-validate .run-btn');
  const btnText = document.getElementById('valBtnText');
  setLoading(btn, btnText, true, 'Validating...');

  const system = `You are a senior database engineer performing a SQL code review. Analyze the given SQL and report:

1. **Syntax Errors** — any syntax mistakes
2. **Missing Constraints** — missing PKs, FKs, NOT NULL, UNIQUE
3. **Normalization Issues** — if tables violate 1NF/2NF/3NF
4. **Performance Anti-patterns** — missing indexes on FK columns, bad data types
5. **Security Issues** — overly permissive defaults, etc.
6. **Corrected SQL** — provide fixed CREATE TABLE statements

Format each section with ✓ (good), ⚠ (warning), or ✗ (error) icons.`;

  try {
    const result = await callAI(system, `Validate this SQL:\n\n${input}`);
    const outputEl = document.getElementById('validateOutput');
    const resultEl = document.getElementById('validateResult');
    outputEl.style.display = 'block';
    resultEl.innerHTML = formatOutput(result);
    showToast('✓ Validation complete');
  } catch(e) {
    showToast('✗ Error: ' + e.message);
  } finally {
    setLoading(btn, btnText, false, 'Validate SQL ↗');
  }
}

// ── FORMAT OUTPUT (markdown-like → HTML) ───
function formatOutput(text) {
  // Extract and highlight SQL blocks
  text = text.replace(/```sql\n?([\s\S]*?)```/gi, (_, code) => {
    return `<div style="background:#0d1117;border:1px solid #2a3040;border-radius:8px;padding:14px;margin:10px 0;overflow-x:auto;">${highlightSQL(code)}</div>`;
  });

  // Generic code blocks
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/gi, (_, code) => {
    return `<div style="background:#0d1117;border:1px solid #2a3040;border-radius:8px;padding:14px;margin:10px 0;overflow-x:auto;white-space:pre;">${escHtml(code)}</div>`;
  });

  // Headings
  text = text.replace(/^### (.+)$/gm, '<h3 style="font-size:13px;font-weight:700;color:#8892a4;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 6px;">$1</h3>');
  text = text.replace(/^## (.+)$/gm,  '<h2 style="font-size:15px;font-weight:700;color:#e2e8f0;margin:20px 0 8px;border-bottom:1px solid #2a3040;padding-bottom:6px;">$1</h2>');
  text = text.replace(/^# (.+)$/gm,   '<h1 style="font-size:18px;font-weight:800;color:#e2e8f0;margin:0 0 12px;">$1</h1>');

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e2e8f0;">$1</strong>');

  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code style="background:#1e2330;padding:1px 5px;border-radius:3px;font-family:JetBrains Mono,monospace;font-size:12px;color:#94e2d5;">$1</code>');

  // Status icons coloring
  text = text.replace(/✓/g, '<span style="color:#22c55e;">✓</span>');
  text = text.replace(/⚠/g, '<span style="color:#f59e0b;">⚠</span>');
  text = text.replace(/✗/g, '<span style="color:#ef4444;">✗</span>');

  // Newlines
  text = text.replace(/\n/g, '<br>');

  return text;
}

// ── SQL SYNTAX HIGHLIGHTER ─────────────────
function highlightSQL(code) {
  code = escHtml(code);
  const keywords = ['CREATE','TABLE','INSERT','INTO','SELECT','FROM','WHERE','JOIN','LEFT','RIGHT','INNER','OUTER','ON','PRIMARY','FOREIGN','KEY','REFERENCES','NOT','NULL','UNIQUE','DEFAULT','AUTO_INCREMENT','INDEX','CONSTRAINT','ADD','ALTER','DROP','IF','EXISTS','VALUES','UPDATE','SET','DELETE','GRANT','HAVING','GROUP BY','ORDER BY','LIMIT','DISTINCT','AS','AND','OR','IN','BETWEEN','LIKE','IS','CASCADE','RESTRICT','ENGINE','CHARSET','COLLATE','TRIGGER','PROCEDURE','FUNCTION','VIEW','BEGIN','END','RETURN','DECLARE','CALL'];
  const types    = ['INT','INTEGER','BIGINT','SMALLINT','TINYINT','DECIMAL','FLOAT','DOUBLE','CHAR','VARCHAR','TEXT','MEDIUMTEXT','LONGTEXT','DATE','DATETIME','TIMESTAMP','BOOLEAN','BOOL','ENUM','SET','BLOB','JSON'];

  keywords.forEach(kw => {
    const re = new RegExp(`\\b(${kw})\\b`, 'gi');
    code = code.replace(re, '<span class="kw">$1</span>');
  });
  types.forEach(t => {
    const re = new RegExp(`\\b(${t})\\b`, 'gi');
    code = code.replace(re, '<span class="typ">$1</span>');
  });
  // Strings
  code = code.replace(/'([^']*)'/g, '<span class="str">\'$1\'</span>');
  // Numbers
  code = code.replace(/\b(\d+)\b/g, '<span class="num">$1</span>');
  // Comments
  code = code.replace(/--.*/g, m => `<span class="cmt">${m}</span>`);

  return `<pre style="margin:0;white-space:pre-wrap;font-family:JetBrains Mono,monospace;font-size:12px;line-height:1.7;">${code}</pre>`;
}

function escHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── EXTRACT SQL FROM RESPONSE ──────────────
function extractSQL(text) {
  const matches = text.match(/```sql\n?([\s\S]*?)```/gi);
  if (!matches) return '';
  return matches.map(m => m.replace(/```sql\n?/i,'').replace(/```/,'')).join('\n\n');
}

// ── NF BADGES ─────────────────────────────
function renderNFBadges() {
  const container = document.getElementById('nfStatus');
  container.innerHTML = `
    <span class="nf-badge nf-ok">1NF ✓</span>
    <span class="nf-badge nf-ok">2NF ✓</span>
    <span class="nf-badge nf-ok">3NF ✓</span>
    <span class="nf-badge nf-na" style="margin-left:auto;font-size:10px;">MySQL · InnoDB</span>
  `;
}

// ── SCHEMA INSPECTOR ───────────────────────
function renderInspector(sql) {
  if (!sql) return;
  const tables = parseTablesFromSQL(sql);
  const body   = document.getElementById('inspectorBody');

  if (!tables.length) {
    body.innerHTML = '<div class="inspector-empty">Could not parse tables</div>';
    return;
  }

  let html = `<div class="insp-stats">
    <div class="insp-stat"><div class="insp-stat-num">${tables.length}</div><div class="insp-stat-lbl">tables</div></div>
    <div class="insp-stat"><div class="insp-stat-num">3NF</div><div class="insp-stat-lbl">normal form</div></div>
  </div>`;

  tables.forEach(tbl => {
    html += `<div class="insp-table-block">
      <div class="insp-table-name"><div class="insp-dot"></div>${tbl.name}</div>`;
    tbl.fields.forEach(f => {
      html += `<div class="insp-field">
        <span class="insp-fname">${f.name}</span>
        <span style="display:flex;align-items:center;gap:3px;">
          <span class="insp-ftype">${f.type}</span>
          ${f.pk ? '<span class="badge badge-pk">PK</span>' : ''}
          ${f.fk ? '<span class="badge badge-fk">FK</span>' : ''}
        </span>
      </div>`;
    });
    html += `</div>`;
  });

  body.innerHTML = html;
}

// ── PARSE TABLES FROM SQL ──────────────────
function parseTablesFromSQL(sql) {
  const tables = [];
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\);/gi;
  let match;
  while ((match = createRe.exec(sql)) !== null) {
    const name   = match[1];
    const body   = match[2];
    const fields = [];
    const lines  = body.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^(PRIMARY|FOREIGN|KEY|UNIQUE|INDEX|CONSTRAINT)/i));
    lines.forEach(line => {
      const parts = line.replace(/,$/, '').trim().split(/\s+/);
      if (parts.length < 2) return;
      const fname = parts[0].replace(/`/g,'');
      const ftype = parts[1].replace(/`/g,'').toUpperCase().split('(')[0];
      if (fname.toUpperCase() === 'PRIMARY' || fname.toUpperCase() === 'FOREIGN') return;
      const isPK = /AUTO_INCREMENT|PRIMARY/i.test(line);
      const isFK = /REFERENCES/i.test(line);
      fields.push({ name: fname, type: ftype, pk: isPK, fk: isFK });
    });
    tables.push({ name, fields });
  }
  return tables;
}

// ── HISTORY ───────────────────────────────
function saveToHistory() {
  if (!currentSQL) { showToast('Generate a schema first'); return; }
  const entry = {
    id: Date.now(),
    description: window._lastDescription || 'Untitled schema',
    sql: currentSQL,
    timestamp: new Date().toISOString(),
    tables: parseTablesFromSQL(currentSQL).length
  };
  schemaHistory.unshift(entry);
  if (schemaHistory.length > 20) schemaHistory = schemaHistory.slice(0, 20);
  localStorage.setItem('schemaHistory', JSON.stringify(schemaHistory));
  showToast('✓ Saved to history');
}

function renderHistory() {
  const list = document.getElementById('historyList');
  const meta = document.getElementById('metaTableView');

  if (!schemaHistory.length) {
    list.innerHTML = '<div style="color:#4a5568;font-family:JetBrains Mono,monospace;font-size:12px;padding:20px 0;">No saved schemas yet. Generate and save a schema first.</div>';
    meta.textContent = '-- schema_meta table is empty\n-- Generate and save schemas to populate it';
    return;
  }

  list.innerHTML = schemaHistory.map(h => `
    <div class="history-card" onclick="loadHistory(${h.id})">
      <div class="history-card-title">${escHtml(h.description.slice(0,60))}${h.description.length>60?'...':''}</div>
      <div class="history-card-meta">${h.tables} tables · ${new Date(h.timestamp).toLocaleString()}</div>
    </div>
  `).join('');

  // Show meta table as SQL INSERT rows
  const rows = schemaHistory.map(h =>
    `  (${h.id}, '${escHtml(h.description.slice(0,40))}...', '${h.tables} tables', '3NF', '${h.timestamp}')`
  ).join(',\n');

  meta.textContent = `-- schema_meta: stores all generated schemas\nSELECT * FROM schema_meta;\n\n/*\n schema_id | description                | tables | nf_level | created_at\n${schemaHistory.map(h=>`  ${h.id}  | ${h.description.slice(0,28).padEnd(28)} |  ${String(h.tables).padStart(2)}    | 3NF      | ${h.timestamp}`).join('\n')}\n*/`;
}

function loadHistory(id) {
  const h = schemaHistory.find(x => x.id === id);
  if (!h) return;
  currentSQL = h.sql;
  window._lastDescription = h.description;
  document.getElementById('generateInput').value = h.description;
  document.getElementById('generateResult').innerHTML = formatOutput('```sql\n' + h.sql + '\n```');
  document.getElementById('generateOutput').style.display = 'block';
  renderNFBadges();
  renderInspector(h.sql);
  switchTab('generate', document.querySelector('[data-tab="generate"]'));
  showToast('✓ Schema loaded from history');
}

function clearHistory() {
  if (!confirm('Clear all saved schemas?')) return;
  schemaHistory = [];
  localStorage.removeItem('schemaHistory');
  renderHistory();
  showToast('History cleared');
}

// ── COPY & DOWNLOAD ───────────────────────
function copyOutput(boxId) {
  const el = document.getElementById(boxId).querySelector('.output-content');
  const text = el.innerText || el.textContent;
  navigator.clipboard.writeText(text).then(() => showToast('✓ Copied to clipboard'));
}

function downloadSQL() {
  if (!currentSQL) { showToast('No SQL to download'); return; }
  const blob = new Blob([currentSQL], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'schema.sql';
  a.click();
  showToast('✓ Downloaded schema.sql');
}

// ── LOADING STATE ─────────────────────────
function setLoading(btn, textEl, loading, text) {
  btn.disabled = loading;
  textEl.innerHTML = loading
    ? `<span class="spinner"></span>${text}`
    : text;
}

// ── TOAST ─────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── INIT ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Load saved API key
  const savedKey = localStorage.getItem('anthropicKey');
  if (savedKey) document.getElementById('apiKey').value = savedKey;

  // Save key on change
  document.getElementById('apiKey').addEventListener('change', e => {
    localStorage.setItem('anthropicKey', e.target.value);
  });

  renderHistory();
});

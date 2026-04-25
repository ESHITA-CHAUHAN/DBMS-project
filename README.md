# SchemaAI DBMS Studio

SchemaAI DBMS Studio is an AI-assisted database schema design app for DBMS coursework. It now supports two runtime modes:

1. `GitHub Pages` static frontend mode for quick demos
2. `Render + Postgres` full-stack cloud mode for a real hosted backend and database

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ESHITA-CHAUHAN/DBMS-project)

## What the full-stack version includes

- frontend UI for schema generation and editing
- Express backend API
- managed database support with PostgreSQL in production
- SQLite fallback for local development
- saved projects, schema versions, validation runs, findings, and revision history
- optional server-side Anthropic, OpenAI, and Gemini calls

## Project structure

```text
.
|-- index.html
|-- style.css
|-- app.js
|-- server.js
|-- render.yaml
|-- server/
|   |-- db.js
|   |-- db/
|   |   |-- helpers.js
|   |   |-- postgres-store.js
|   |   `-- sqlite-store.js
|   `-- schema-engine.js
|-- sql/
|   `-- core_meta_schema.sql
|-- .env.example
|-- package.json
`-- .github/
    `-- workflows/
        `-- pages.yml
```

## Runtime modes

### 1. GitHub Pages static frontend

Public frontend URL:

[https://eshita-chauhan.github.io/DBMS-project/](https://eshita-chauhan.github.io/DBMS-project/)

This mode is still useful for:

- offline demo generation
- local browser validation
- normalization lab
- static sharing

It does not run the Node backend.

After the Render backend is live, you can optionally point the existing GitHub Pages frontend at it by opening the Pages URL with:

```text
?apiBase=https://your-render-service.onrender.com
```

### 2. Render cloud deployment

The production deployment is designed for:

- one Render web service
- one Render Postgres database
- the frontend served by the same Node service
- backend APIs and persistence at the same public URL

The Render setup is defined in `render.yaml`.

## Backend API

The server exposes:

- `GET /api/health`
- `POST /api/generate`
- `POST /api/validate`
- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`
- `DELETE /api/projects`
- `GET /api/meta/schema`
- `GET /api/meta/rows`

## Database behavior

### Production

If `DATABASE_URL` is present, the app uses PostgreSQL with automatic startup migrations.

### Local development

If `DATABASE_URL` is missing, the app falls back to SQLite at:

```text
data/schemaai.db
```

Both database modes persist:

- projects
- generation events
- schema versions
- schema tables
- schema columns
- relationships
- validation runs
- validation findings
- revision events

## Environment variables

Copy `.env.example` to `.env` for local development:

```powershell
Copy-Item .env.example .env
```

Available settings:

```env
PORT=3000
DATABASE_URL=
DATABASE_SSL=
CORS_ORIGIN=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
```

Notes:

- `DATABASE_URL` enables PostgreSQL mode
- `DATABASE_SSL=true` is recommended for managed cloud databases
- `CORS_ORIGIN` is optional and is only needed if you want a separate frontend origin to call the backend

## Local development

Install dependencies:

```powershell
npm install
```

Run the app:

```powershell
npm start
```

Then open:

[http://localhost:3000](http://localhost:3000)

## Deploying the real cloud version on Render

This repo is ready for Render Blueprints.

### Fast path

1. Push the latest code to GitHub.
2. Click the **Deploy to Render** button above.
3. Approve the blueprint.
4. Enter your `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and/or `GEMINI_API_KEY` when Render prompts for them.
5. Wait for Render to create:
   - one web service
   - one Postgres database
6. Open the generated `https://...onrender.com` URL.

### What Render creates

- a public Node web service for the app
- a managed Postgres database
- an internal `DATABASE_URL` wired automatically from the database to the app service

## Frontend and backend flow

1. User enters a project description.
2. Frontend calls `/api/generate`.
3. Backend generates SQL using:
   - the offline schema engine, or
   - Anthropic, OpenAI, or Gemini
4. Backend validates SQL.
5. Frontend shows SQL, findings, and inspector details.
6. User saves the design.
7. Frontend calls `/api/projects`.
8. Backend stores the project, version, findings, and relationships in the database.
9. History and Meta Schema views reload from backend data.

## Gemini reliability

The backend uses a stricter Gemini flow than the original static frontend:

- SQL-first prompting
- structured output attempt
- SQL extraction and cleanup
- local validation
- rescue fallback to the built-in schema engine if the provider output is weak

## DBMS concepts covered

- entity discovery
- schema design
- primary keys
- foreign keys
- unique constraints
- indexes
- many-to-many bridge tables
- normalization to 3NF / BCNF
- validation findings
- metadata-driven schema lifecycle

## Important deployment note

GitHub Pages can only host the static frontend. A true hosted backend requires a platform that runs Node and provides a real database, which is why the full production path in this repo targets Render plus Postgres.

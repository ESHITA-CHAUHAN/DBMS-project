# SchemaAI DBMS Studio

AI-assisted database schema-design assistant for a DBMS project. The app helps students move from a plain-English project idea to normalized SQL, then refine and validate that SQL using local browser analysis and optional LLM APIs.

## What Is Included

- Static web app that runs on GitHub Pages.
- Offline demo engine for schema generation without an API key.
- Optional API providers: Anthropic Messages API, OpenAI chat API, and Google Gemini API.
- SQL workbench for student edits and validation.
- Normalization lab for 1NF, 2NF, and 3NF reasoning from functional dependencies.
- Rich meta schema for storing descriptions, schema versions, validation runs, findings, relationships, AI events, and revision events.
- Browser localStorage history that behaves like a lightweight `schema_meta` table for demos.

## Project Structure

```text
.
|-- index.html
|-- style.css
|-- app.js
|-- sql/
|   `-- core_meta_schema.sql
`-- .github/
    `-- workflows/
        `-- pages.yml
```

## Run Locally

Open `index.html` directly in a browser, or serve the folder locally:

```powershell
python -m http.server 4173
```

Then visit `http://localhost:4173`.

## Deploy On GitHub Pages

This repository includes `.github/workflows/pages.yml`. After the code is pushed to GitHub:

1. Open the GitHub repository.
2. Go to `Settings` -> `Pages`.
3. Set the source to `GitHub Actions` if it is not already selected.
4. Push to `main`.
5. Open the Pages URL shown by GitHub after the workflow completes.

For this repository, the expected Pages URL is:

```text
https://eshita-chauhan.github.io/DBMS-project/
```

## API Keys

The app can run completely offline with the demo engine. If a student chooses an external provider, the API key is stored only in that browser's localStorage and is never committed to the repo. For production use, route provider calls through a backend proxy instead of calling APIs directly from the browser.

## DBMS Concepts Covered

- Entity discovery from project descriptions.
- Primary keys, foreign keys, unique constraints, and indexes.
- Many-to-many relationship resolution through associative tables.
- Normalization to 3NF and BCNF discussion.
- SQL validation findings with severity, table, and column context.
- Meta-data driven schema versioning and validation history.

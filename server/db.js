function selectStore() {
  if (process.env.DATABASE_URL) {
    const createPostgresStore = require("./db/postgres-store");
    return createPostgresStore({
      connectionString: process.env.DATABASE_URL,
      sslMode: process.env.DATABASE_SSL || ""
    });
  }
  const createSqliteStore = require("./db/sqlite-store");
  return createSqliteStore();
}

module.exports = selectStore();

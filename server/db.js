const createPostgresStore = require("./db/postgres-store");
const createSqliteStore = require("./db/sqlite-store");

function selectStore() {
  if (process.env.DATABASE_URL) {
    return createPostgresStore({
      connectionString: process.env.DATABASE_URL,
      sslMode: process.env.DATABASE_SSL || ""
    });
  }
  return createSqliteStore();
}

module.exports = selectStore();

import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url =
  process.env.DATABASE_URL ??
  "postgres://orchestra:orchestra@localhost:5433/orchestra";

const pool = new Pool({ connectionString: url });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url))
  });
  console.log("migrations applied");
} finally {
  await pool.end();
}

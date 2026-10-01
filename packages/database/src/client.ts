import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type OrchestraDb = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string): {
  db: OrchestraDb;
  pool: Pool;
} {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export { schema };

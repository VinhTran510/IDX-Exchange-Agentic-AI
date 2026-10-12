// Read-only MySQL connection. Credentials come from environment variables (.env.agent), never the repo.
import mysql from "mysql2/promise";
import type { Row } from "./listingCards.ts";

export function createRunner(env: NodeJS.ProcessEnv = process.env) {
  for (const k of ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"]) {
    if (!env[k]) throw Object.assign(new Error(`${k} is not set`), { code: "ENV_MISSING" });
  }
  const pool = mysql.createPool({
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT ? Number(env.MYSQL_PORT) : 3306,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    connectionLimit: 5,
    connectTimeout: 5000,
  });
  return {
    // pool.execute uses server-side prepared statements: values are never spliced into the SQL.
    run: async (sql: string, params: (string | number)[]): Promise<Row[]> => {
      const [rows] = await pool.execute(sql, params);
      return rows as Row[];
    },
    close: () => pool.end(),
  };
}

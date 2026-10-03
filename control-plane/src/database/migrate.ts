import { migrate, pool } from "./connection.js";

migrate().then(() => console.log("PostgreSQL migrations applied.")).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => pool.end());

import { runMigrations, closeDb } from "./src/db/database.js";

(async () => {
  await runMigrations();
  await closeDb();
  console.log("done");
})();

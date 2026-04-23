/**
 * Database setup script for local development.
 *
 * Creates the database if it doesn't exist, then runs migrations.
 *
 * Usage:
 *   npm run db:setup
 */

import { execSync } from "child_process";
import { runMigrations, closeDb } from "../src/db/database.js";
import { config } from "../src/config/config.js";

function createDatabaseIfNotExists(): void {
  const url = new URL(config.databaseUrl);
  const dbName = url.pathname.slice(1);
  const host = url.hostname;
  const port = url.port || "5432";
  const user = url.username;

  console.info(`Creating database '${dbName}' if it doesn't exist...`);

  try {
    const exists = execSync(
      `psql -h ${host} -p ${port} -U ${user} -tc "SELECT 1 FROM pg_database WHERE datname = '${dbName}'"`,
      { encoding: "utf-8" }
    ).trim();

    if (!exists.includes("1")) {
      execSync(`psql -h ${host} -p ${port} -U ${user} -c "CREATE DATABASE ${dbName}"`, {
        stdio: "inherit",
      });
      console.info(`  Created database '${dbName}'`);
    } else {
      console.info(`  Database '${dbName}' already exists`);
    }
  } catch (err) {
    console.error("Failed to create database. Is Postgres running?", err);
    process.exit(1);
  }
}

async function run(): Promise<void> {
  createDatabaseIfNotExists();
  console.info("Running migrations...");
  await runMigrations();
  await closeDb();
  console.info("Done. Database is ready.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

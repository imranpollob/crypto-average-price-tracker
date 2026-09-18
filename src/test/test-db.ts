import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createPrismaClient, type Db } from "@/server/db/client";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

/**
 * A fresh SQLite file with the real migrations applied (the same SQL that
 * `prisma migrate deploy` would run). Each test gets an isolated database.
 */
export async function createTestDb(): Promise<{ db: Db; file: string; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "capt-test-"));
  const file = join(dir, "test.db");
  const sqlite = new Database(file);
  for (const m of readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, m.name, "migration.sql"), "utf8"));
  }
  sqlite.close();
  const db = createPrismaClient(`file:${file}`);
  return {
    db,
    file,
    cleanup: async () => {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

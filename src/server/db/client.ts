import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

export type Db = InstanceType<typeof PrismaClient>;

export const DEFAULT_DATABASE_URL = "file:./data/portfolio.db";

export function createPrismaClient(databaseUrl: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): Db {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { __portfolioDb?: Db };

/** Process-wide client (survives Next.js dev hot reloads). Server-side only. */
export function getDb(): Db {
  globalForPrisma.__portfolioDb ??= createPrismaClient();
  return globalForPrisma.__portfolioDb;
}

import { PrismaClient } from "@/generated/prisma/client";
import path from "path";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  seeded: boolean | undefined;
};

function createPrismaClient() {
  const dbPath = path.join(process.cwd(), "prisma", "dev.db");
  return new PrismaClient({
    datasourceUrl: `file:${dbPath}`,
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Seed default user on first server start (non-blocking)
if (!globalForPrisma.seeded) {
  globalForPrisma.seeded = true;
  import("./auth").then((auth) => auth.seedDefaultUser()).catch(() => {});
}

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { kkchatPrisma?: PrismaClient };

export const prisma =
  globalForPrisma.kkchatPrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.kkchatPrisma = prisma;

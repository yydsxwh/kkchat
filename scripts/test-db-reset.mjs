// 只用于本地/CI 测试库：清空 public schema 后按迁移重建，验证迁移能从零执行。
// 拒绝对库名不含 test 的地址执行，避免误伤开发库或生产库。
import { execSync } from "node:child_process";
import pg from "@prisma/client";

const url = process.env.KKCHAT_TEST_DATABASE_URL || "postgresql://kkchat:kkchat@127.0.0.1:5432/kkchat_test";
const name = new URL(url).pathname.replace(/^\//, "");
if (!/test/i.test(name)) {
  console.error(`refuse to reset database "${name}": name must contain "test"`);
  process.exit(1);
}
const client = new pg.PrismaClient({ datasources: { db: { url } } });
await client.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
await client.$executeRawUnsafe("CREATE SCHEMA public");
await client.$disconnect();
execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

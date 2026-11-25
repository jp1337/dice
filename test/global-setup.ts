// Drops the per-file test databases (helpers.ts ownDatabase) once every file has finished. Dropping each at
// the end of its own file needed "with (force)" while other files still ran, and in CI that now and then
// cut a live connection: an unhandled 57P01 failed the run. Here no test is left to notice.
import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dbPrefix: string;
  }
}

export default function setup(project: TestProject) {
  const prefix = `dice_test_${randomBytes(4).toString("hex")}_`; // this run only: other runs may share the server
  project.provide("dbPrefix", prefix);
  return async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ datname: string }>("select datname from pg_database where starts_with(datname, $1)", [prefix]);
      for (const { datname } of rows) await admin.query(`drop database ${datname} with (force)`);
    } finally {
      await admin.end();
    }
  };
}

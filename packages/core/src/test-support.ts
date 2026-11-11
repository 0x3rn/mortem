import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1ExecResultLike,
  R2BucketLike,
  R2ObjectMetaLike,
  R2PutOptionsLike,
} from "./cloudflare";

/**
 * Test-only helpers: an in-memory SQLite database that satisfies `D1DatabaseLike`
 * (with the real migration files applied) and an in-memory R2 bucket.
 * Never imported by production code.
 */

const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

export const MIGRATION_FILES = {
  auth: "0001_auth_and_workspaces.sql",
  scans: "0002_scans_evidence_findings_reports.sql",
  intake: "0003_intake_rate_limits.sql",
  performance: "0004_page_performance_results.sql",
} as const;

export interface SqliteD1 extends D1DatabaseLike {
  /** Number of times `batch()` was called. */
  batchCalls: number;
  /** Direct access for assertions that the D1 interface does not expose. */
  sqlite: DatabaseSync;
}

export function createSqliteD1(
  migrations: readonly string[] = [
    MIGRATION_FILES.auth,
    MIGRATION_FILES.scans,
    MIGRATION_FILES.performance,
  ],
  options: { withBatch?: boolean } = {},
): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrations) {
    sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }

  function bind(query: string, values: unknown[]): D1BoundStatementLike {
    const normalized = values.map((value) =>
      value === undefined ? null : (value as string | number | bigint | null),
    );
    return {
      async run(): Promise<D1ExecResultLike> {
        sqlite.prepare(query).run(...normalized);
        return { success: true };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const row = sqlite.prepare(query).get(...normalized) as T | undefined;
        return row ?? null;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const rows = sqlite.prepare(query).all(...normalized) as T[];
        return { success: true, results: rows };
      },
    };
  }

  const db: SqliteD1 = {
    batchCalls: 0,
    sqlite,
    prepare(query: string) {
      return {
        bind: (...values: unknown[]) => bind(query, values),
      };
    },
  };

  if (options.withBatch) {
    db.batch = async (statements: D1BoundStatementLike[]) => {
      db.batchCalls += 1;
      sqlite.exec("BEGIN");
      try {
        const results: D1ExecResultLike[] = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    };
  }

  return db;
}

export interface InMemoryR2 extends R2BucketLike {
  objects: Map<string, { bytes: Uint8Array; options?: R2PutOptionsLike }>;
}

export function createInMemoryR2(): InMemoryR2 {
  const objects = new Map<
    string,
    { bytes: Uint8Array; options?: R2PutOptionsLike }
  >();
  return {
    objects,
    async put(key, value, putOptions): Promise<R2ObjectMetaLike | null> {
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value
            : new Uint8Array(value);
      objects.set(key, { bytes, options: putOptions });
      return { key, size: bytes.byteLength };
    },
    async head(key): Promise<R2ObjectMetaLike | null> {
      const found = objects.get(key);
      return found ? { key, size: found.bytes.byteLength } : null;
    },
  };
}

export interface SeedPage {
  id: string;
  url: string;
  templateType?: string;
  captureStatus?: string;
  loadTimingsJson?: string;
  createdAt?: number;
}

/** Inserts a user, workspace, site, scan and pages. Returns the workspace id. */
export async function seedScanWithPages(
  d1: D1DatabaseLike,
  params: { scanId: string; origin: string; pages: SeedPage[]; nowMs?: number },
): Promise<{ workspaceId: string }> {
  const nowMs = params.nowMs ?? 1_760_000_000_000;
  const workspaceId = `ws_${params.scanId}`;
  const userId = `usr_${params.scanId}`;

  await d1
    .prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, 'Owner', ?, 1, ?, ?)`,
    )
    .bind(userId, `${userId}@example.test`, nowMs, nowMs)
    .run();
  await d1
    .prepare(
      `INSERT INTO workspaces (id, name, slug, owner_user_id, plan, created_at, updated_at)
       VALUES (?, 'Test workspace', ?, ?, 'single', ?, ?)`,
    )
    .bind(workspaceId, `slug-${params.scanId}`, userId, nowMs, nowMs)
    .run();
  await d1
    .prepare(
      `INSERT INTO sites (id, workspace_id, origin, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `site_${params.scanId}`,
      workspaceId,
      params.origin,
      params.origin,
      nowMs,
      nowMs,
    )
    .run();
  await d1
    .prepare(
      `INSERT INTO scans (id, workspace_id, site_id, target_url, normalized_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'checking', ?, ?)`,
    )
    .bind(
      params.scanId,
      workspaceId,
      `site_${params.scanId}`,
      `${params.origin}/`,
      `${params.origin}/`,
      nowMs,
      nowMs,
    )
    .run();

  for (const [index, page] of params.pages.entries()) {
    await d1
      .prepare(
        `INSERT INTO pages (
           id, scan_id, url, normalized_url, template_type, status_code,
           load_timings_json, capture_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 200, ?, ?, ?, ?)`,
      )
      .bind(
        page.id,
        params.scanId,
        page.url,
        page.url,
        page.templateType ?? "other",
        page.loadTimingsJson ?? "{}",
        page.captureStatus ?? "captured",
        page.createdAt ?? nowMs + index,
        nowMs,
      )
      .run();
  }

  return { workspaceId };
}

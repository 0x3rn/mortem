import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1ExecResultLike,
} from "./cloudflare";
import {
  SCAN_STAGES,
  SCAN_STATUSES,
  computeWeightedOverallScore,
  createDeterministicScanFixture,
  evidenceArtifacts,
  findingOccurrences,
  findings,
  isValidScanStatusTransition,
  mortemSchema,
  pages,
  provisionPersonalWorkspace,
  reports,
  scans,
  scores,
  seedDeterministicScanFixture,
  validateCategoryScoreInput,
} from "./index";

const MIGRATION_0000_SQL = readFileSync(
  join(__dirname, "../migrations/0000_platform_smoke.sql"),
  "utf8",
);
const MIGRATION_0001_SQL = readFileSync(
  join(__dirname, "../migrations/0001_auth_and_workspaces.sql"),
  "utf8",
);
const MIGRATION_0002_SQL = readFileSync(
  join(__dirname, "../migrations/0002_scans_evidence_findings_reports.sql"),
  "utf8",
);

function createSqliteD1Adapter(): {
  d1: D1DatabaseLike;
  sqlite: DatabaseSync;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(MIGRATION_0000_SQL);
  sqlite.exec(MIGRATION_0001_SQL);
  sqlite.exec(MIGRATION_0002_SQL);

  function createBound(
    query: string,
    params: unknown[],
  ): D1BoundStatementLike & { raw?: () => Promise<unknown[][]> } {
    const normalizedParams = params.map((value) => {
      if (value === undefined) return null;
      if (typeof value === "boolean") return value ? 1 : 0;
      if (value instanceof Date) return value.getTime();
      return value as SQLInputValue;
    });

    return {
      async run(): Promise<D1ExecResultLike> {
        const stmt = sqlite.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalizedParams) as Record<
            string,
            unknown
          >[];
          return { success: true, results: rows };
        }
        stmt.run(...normalizedParams);
        return { success: true, results: [] };
      },
      async first<T = Record<string, unknown>>(
        colName?: string,
      ): Promise<T | null> {
        const stmt = sqlite.prepare(query);
        const row = stmt.get(...normalizedParams) as
          Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) {
          return (row[colName] as T) ?? null;
        }
        return row as T;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const stmt = sqlite.prepare(query);
        const isReader =
          /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) ||
          /\bRETURNING\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalizedParams) as T[];
          return { success: true, results: rows };
        }
        stmt.run(...normalizedParams);
        return { success: true, results: [] };
      },
      async raw(): Promise<unknown[][]> {
        const stmt = sqlite.prepare(query);
        const isReader =
          /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) ||
          /\bRETURNING\b/i.test(query);
        if (!isReader) {
          stmt.run(...normalizedParams);
          return [];
        }
        const rows = stmt.all(...normalizedParams) as Record<string, unknown>[];
        return rows.map((row) => Object.values(row));
      },
    };
  }

  const d1: D1DatabaseLike = {
    prepare(query: string) {
      const defaultBound = createBound(query, []);
      return {
        ...defaultBound,
        bind(...values: unknown[]) {
          return createBound(query, values);
        },
      };
    },
    async batch(statements: D1BoundStatementLike[]) {
      const results: D1ExecResultLike[] = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
  };

  return { d1, sqlite };
}

async function seedWorkspaceOwner(d1: D1DatabaseLike, userId = "usr_172") {
  const now = Date.now();
  await d1
    .prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .bind(userId, "Dr. Ada Forensic", `${userId}@mortem.dev`, now, now)
    .run();

  return provisionPersonalWorkspace(d1, {
    id: userId,
    name: "Dr. Ada Forensic",
    email: `${userId}@mortem.dev`,
  });
}

describe("D1 scan, evidence, finding, score, and report schema (THE-172)", () => {
  it("applies 0000, 0001, and 0002 migrations cleanly and seeds a complete scan fixture readable via Drizzle ORM", async () => {
    const { d1 } = createSqliteD1Adapter();
    const workspace = await seedWorkspaceOwner(d1, "usr_complete");

    const fixture = createDeterministicScanFixture({
      workspaceId: workspace.workspaceId,
      mode: "complete",
    });
    await seedDeterministicScanFixture(d1, fixture);

    const db = drizzle(d1 as unknown as Parameters<typeof drizzle>[0], {
      schema: mortemSchema,
    });

    const scanRows = await db
      .select()
      .from(scans)
      .where(eq(scans.id, fixture.scan.id));
    expect(scanRows).toHaveLength(1);
    expect(scanRows[0]?.status).toBe("complete");
    expect(scanRows[0]?.normalizedUrl).toBe("https://acme-cloud.io/");

    const pageRows = await db
      .select()
      .from(pages)
      .where(eq(pages.scanId, fixture.scan.id));
    expect(pageRows).toHaveLength(2);

    const artifactRows = await db
      .select()
      .from(evidenceArtifacts)
      .where(eq(evidenceArtifacts.scanId, fixture.scan.id));
    expect(artifactRows).toHaveLength(2);

    const findingRows = await db
      .select()
      .from(findings)
      .where(eq(findings.scanId, fixture.scan.id));
    expect(findingRows).toHaveLength(2);

    const occurrenceRows = await db.select().from(findingOccurrences);
    expect(occurrenceRows).toHaveLength(2);

    // Every finding occurrence links to a valid finding_id, page_id, and evidence_artifact_id
    for (const occ of occurrenceRows) {
      expect(findingRows.some((f) => f.id === occ.findingId)).toBe(true);
      expect(pageRows.some((p) => p.id === occ.pageId)).toBe(true);
      expect(artifactRows.some((a) => a.id === occ.evidenceArtifactId)).toBe(
        true,
      );
    }

    const scoreRows = await db
      .select()
      .from(scores)
      .where(eq(scores.scanId, fixture.scan.id));
    expect(scoreRows).toHaveLength(7);
    expect(
      scoreRows.every((s) => s.included && typeof s.score === "number"),
    ).toBe(true);

    const reportRows = await db
      .select()
      .from(reports)
      .where(eq(reports.scanId, fixture.scan.id));
    expect(reportRows).toHaveLength(1);
    expect(reportRows[0]?.overallScore).toBe(fixture.report.overallScore);
  });

  it("enforces foreign key provenance on finding_occurrences and blocks deleting referenced evidence_artifacts (ON DELETE RESTRICT)", async () => {
    const { d1 } = createSqliteD1Adapter();
    const workspace = await seedWorkspaceOwner(d1, "usr_fk");
    const fixture = createDeterministicScanFixture({
      workspaceId: workspace.workspaceId,
      mode: "complete",
    });
    await seedDeterministicScanFixture(d1, fixture);

    // Attempting to insert a finding_occurrence with a non-existent evidence_artifact_id fails FK check
    await expect(
      d1
        .prepare(
          `INSERT INTO finding_occurrences (
            id, finding_id, page_id, evidence_artifact_id, selector, excerpt, bbox_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "occ_invalid_ev",
          fixture.findings[0]!.id,
          fixture.pages[0]!.id,
          "ev_does_not_exist",
          "body",
          "<body>",
          null,
          Date.now(),
        )
        .run(),
    ).rejects.toThrow();

    // Attempting to delete an evidence_artifact that is referenced by a finding_occurrence is blocked by ON DELETE RESTRICT
    await expect(
      d1
        .prepare(`DELETE FROM evidence_artifacts WHERE id = ?`)
        .bind(fixture.evidenceArtifacts[0]!.id)
        .run(),
    ).rejects.toThrow();
  });

  it("persists partial scans with included = false, score = null, and exclusion_reason — and rejects fabricated scores on excluded categories", async () => {
    const { d1 } = createSqliteD1Adapter();
    const workspace = await seedWorkspaceOwner(d1, "usr_partial");
    const partialFixture = createDeterministicScanFixture({
      workspaceId: workspace.workspaceId,
      mode: "partial",
    });
    await seedDeterministicScanFixture(d1, partialFixture);

    const db = drizzle(d1 as unknown as Parameters<typeof drizzle>[0], {
      schema: mortemSchema,
    });

    const scoreRows = await db
      .select()
      .from(scores)
      .where(eq(scores.scanId, partialFixture.scan.id));
    expect(scoreRows).toHaveLength(7);

    const perfScore = scoreRows.find((s) => s.category === "performance");
    expect(perfScore).toBeDefined();
    expect(perfScore?.included).toBe(false);
    expect(perfScore?.score).toBeNull();
    expect(perfScore?.exclusionReason).toContain("PageSpeed Insights");

    // TypeScript validator rejects excluded category with numeric score or missing exclusionReason
    expect(() =>
      validateCategoryScoreInput({
        category: "performance",
        score: 50,
        included: false,
        exclusionReason: "Timed out",
      }),
    ).toThrow(/never store fabricated scores/);

    expect(() =>
      validateCategoryScoreInput({
        category: "performance",
        score: null,
        included: false,
        exclusionReason: "   ",
      }),
    ).toThrow(/requires a non-empty exclusionReason/);

    // SQLite CHECK constraint also rejects excluded category with a fake numeric score at the DB level
    await expect(
      d1
        .prepare(
          `INSERT INTO scores (
            id, scan_id, category, score, weight, included, exclusion_reason, scoring_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "bad_score_row",
          partialFixture.scan.id,
          "seo",
          75,
          0.15,
          0,
          "Excluded but fake score supplied",
          "v1.0.0",
          Date.now(),
        )
        .run(),
    ).rejects.toThrow();
  });

  it("validates scan status lifecycle transitions and weighted score re-normalization", () => {
    expect(SCAN_STATUSES).toEqual(SCAN_STAGES);
    expect(SCAN_STATUSES).toEqual([
      "queued",
      "discovering",
      "capturing",
      "checking",
      "scoring",
      "generating_report",
      "complete",
      "partial",
      "failed",
    ]);

    expect(isValidScanStatusTransition("queued", "discovering")).toBe(true);
    expect(isValidScanStatusTransition("discovering", "capturing")).toBe(true);
    expect(isValidScanStatusTransition("capturing", "checking")).toBe(true);
    expect(isValidScanStatusTransition("checking", "scoring")).toBe(true);
    expect(isValidScanStatusTransition("scoring", "generating_report")).toBe(
      true,
    );
    expect(isValidScanStatusTransition("generating_report", "complete")).toBe(
      true,
    );
    expect(isValidScanStatusTransition("generating_report", "partial")).toBe(
      true,
    );
    expect(isValidScanStatusTransition("capturing", "failed")).toBe(true);
    expect(isValidScanStatusTransition("complete", "queued")).toBe(false);
    expect(isValidScanStatusTransition("failed", "scoring")).toBe(false);

    const records = [
      validateCategoryScoreInput({
        category: "performance",
        score: null,
        included: false,
        exclusionReason: "PSI quota exceeded",
      }),
      validateCategoryScoreInput({
        category: "conversion",
        score: 80,
        weight: 0.5,
        included: true,
      }),
      validateCategoryScoreInput({
        category: "seo",
        score: 60,
        weight: 0.5,
        included: true,
      }),
    ];
    expect(computeWeightedOverallScore(records)).toBe(70);
  });
});

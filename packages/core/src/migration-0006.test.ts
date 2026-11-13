import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_FILES,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";

/**
 * Migration 0006 rebuilds `evidence_artifacts` to add two evidence kinds.
 * Two other tables point at it: finding_occurrences (ON DELETE RESTRICT) and
 * page_performance_results (ON DELETE SET NULL). A naive DROP TABLE would
 * block on the first and silently null the second, so this test proves the
 * rebuild keeps every row and every reference.
 */

const MIGRATION_0006 = readFileSync(
  resolve(__dirname, "../migrations/0006_evidence_kinds_mobile_links.sql"),
  "utf8",
);
const SHA = "a".repeat(64);

/** D1 runs a migration as one transaction; mirror that. */
function applyInTransaction(db: ReturnType<typeof createSqliteD1>["sqlite"]) {
  db.exec("BEGIN");
  try {
    db.exec(MIGRATION_0006);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Columns, foreign keys (with actions) and indexes of a table. */
function shape(db: ReturnType<typeof createSqliteD1>["sqlite"], table: string) {
  const strip = (rows: unknown[]) =>
    // Foreign-key row ids change with table order; compare everything else.
    rows.map((r) =>
      Object.fromEntries(
        Object.entries(r as Record<string, unknown>).filter(
          ([key]) => key !== "id" && key !== "seq",
        ),
      ),
    );
  return {
    columns: db.prepare(`PRAGMA table_xinfo(${table})`).all(),
    foreignKeys: strip(db.prepare(`PRAGMA foreign_key_list(${table})`).all()),
    indexes: (
      db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
        name: string;
        unique: number;
      }>
    )
      .map((i) => `${i.name}:${i.unique}`)
      .sort(),
  };
}

async function seededDatabase() {
  const d1 = createSqliteD1([
    MIGRATION_FILES.auth,
    MIGRATION_FILES.scans,
    MIGRATION_FILES.performance,
    MIGRATION_FILES.discoverySources,
  ]);
  await seedScanWithPages(d1, {
    scanId: "scan_m6",
    origin: "https://acme.test",
    pages: [{ id: "page_m6", url: "https://acme.test/" }],
  });
  const db = d1.sqlite;
  const insertEvidence = db.prepare(
    `INSERT INTO evidence_artifacts (id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at)
     VALUES (?, 'scan_m6', 'page_m6', ?, ?, 10, ?, '{"k":1}', 1)`,
  );
  insertEvidence.run("ev_html", "html", "k/html", SHA);
  insertEvidence.run("ev_psi", "psi_raw", "k/psi", SHA);
  insertEvidence.run("ev_pdf", "pdf", "k/pdf", SHA);
  db.prepare(
    `INSERT INTO findings (id, scan_id, check_id, category, severity, effort, impact, priority_score, title, measured_value_json, threshold_json, fix_role, created_at, updated_at)
     VALUES ('f1', 'scan_m6', 'seo.title.missing', 'seo', 'high', 'low', 'high', 70, 'No title', '{}', '{}', 'content', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO finding_occurrences (id, finding_id, page_id, evidence_artifact_id, created_at)
     VALUES ('o1', 'f1', 'page_m6', 'ev_html', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO page_performance_results (id, scan_id, page_id, strategy, status, unavailable_reason, unavailable_message, psi_evidence_artifact_id, created_at, updated_at)
     VALUES ('pr1', 'scan_m6', 'page_m6', 'mobile', 'unavailable', 'timeout', 'PSI timed out', 'ev_psi', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO reports (id, scan_id, workspace_id, overall_score, pdf_artifact_id, created_at, updated_at)
     VALUES ('r1', 'scan_m6', (SELECT workspace_id FROM scans WHERE id = 'scan_m6'), 80, 'ev_pdf', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO report_shares (id, report_id, workspace_id, share_token, created_at)
     VALUES ('sh1', 'r1', (SELECT workspace_id FROM scans WHERE id = 'scan_m6'), 'tok_1', 1)`,
  ).run();
  return d1;
}

describe("migration 0006: evidence kinds mobile_raw and links_raw", () => {
  it("keeps every evidence row and every reference to it", async () => {
    const d1 = await seededDatabase();
    const db = d1.sqlite;
    const before = db
      .prepare(`SELECT * FROM evidence_artifacts ORDER BY id`)
      .all();

    applyInTransaction(db);

    expect(
      db.prepare(`SELECT * FROM evidence_artifacts ORDER BY id`).all(),
    ).toEqual(before);
    // SET NULL did not fire and RESTRICT did not block.
    expect(
      db
        .prepare(
          `SELECT psi_evidence_artifact_id AS id FROM page_performance_results`,
        )
        .get(),
    ).toEqual({ id: "ev_psi" });
    expect(
      db
        .prepare(`SELECT evidence_artifact_id AS id FROM finding_occurrences`)
        .get(),
    ).toEqual({ id: "ev_html" });
    // Both tables still reference evidence_artifacts (not the renamed copy).
    for (const table of [
      "finding_occurrences",
      "page_performance_results",
      "reports",
    ]) {
      const fks = db
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all() as Array<{ table: string; from: string }>;
      const evidenceFk = fks.find((fk) =>
        /evidence_artifact_id|pdf_artifact_id/.test(fk.from),
      );
      expect(evidenceFk?.table, table).toBe("evidence_artifacts");
    }
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    // Nothing may still point at a renamed copy (that bug hid in reports).
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name LIKE '%pre_0006%' OR sql LIKE '%pre_0006%' OR name LIKE '%\\_new' ESCAPE '\\'`,
        )
        .all(),
    ).toEqual([]);
    expect(
      db.prepare(`SELECT pdf_artifact_id AS id FROM reports`).get(),
    ).toEqual({ id: "ev_pdf" });
    expect(db.prepare(`SELECT id, report_id FROM report_shares`).all()).toEqual(
      [{ id: "sh1", report_id: "r1" }],
    );
    // Deleting the whole scan still cascades through every table.
    db.prepare(`DELETE FROM scans WHERE id = 'scan_m6'`).run();
    for (const table of [
      "evidence_artifacts",
      "finding_occurrences",
      "page_performance_results",
      "reports",
      "report_shares",
    ]) {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      ).n;
      expect(n, table).toBe(0);
    }
    const indexes = (
      db.prepare(`PRAGMA index_list(evidence_artifacts)`).all() as Array<{
        name: string;
      }>
    ).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_evidence_artifacts_scan_id",
        "idx_evidence_artifacts_page_id",
        "idx_evidence_artifacts_scan_kind",
      ]),
    );
  });

  it("leaves the two rebuilt tables with exactly the same columns, keys, actions and indexes", async () => {
    const d1 = await seededDatabase();
    const db = d1.sqlite;
    const before = {
      occurrences: shape(db, "finding_occurrences"),
      performance: shape(db, "page_performance_results"),
      reports: shape(db, "reports"),
      shares: shape(db, "report_shares"),
      evidenceColumns: shape(db, "evidence_artifacts").columns,
    };
    applyInTransaction(db);
    // One deliberate change: the occurrence → evidence key becomes NO ACTION
    // (checked at statement end) instead of RESTRICT (checked immediately), so
    // deleting a scan no longer depends on the order SQLite cascades in.
    expect(shape(db, "finding_occurrences")).toEqual({
      ...before.occurrences,
      foreignKeys: before.occurrences.foreignKeys.map((fk) =>
        (fk as { table: string }).table === "evidence_artifacts"
          ? { ...(fk as object), on_delete: "NO ACTION" }
          : fk,
      ),
    });
    expect(shape(db, "page_performance_results")).toEqual(before.performance);
    expect(shape(db, "reports")).toEqual(before.reports);
    expect(shape(db, "report_shares")).toEqual(before.shares);
    expect(shape(db, "evidence_artifacts").columns).toEqual(
      before.evidenceColumns,
    );
  });

  it("accepts the new kinds and still rejects unknown ones and broken references", async () => {
    const d1 = await seededDatabase();
    const db = d1.sqlite;
    applyInTransaction(db);
    const insert = (id: string, kind: string, scanId = "scan_m6") =>
      db
        .prepare(
          `INSERT INTO evidence_artifacts (id, scan_id, page_id, kind, r2_key, byte_size, sha256, created_at)
           VALUES (?, ?, 'page_m6', ?, 'k', 1, ?, 1)`,
        )
        .run(id, scanId, kind, SHA);
    expect(() => insert("ev_mobile", "mobile_raw")).not.toThrow();
    expect(() => insert("ev_links", "links_raw")).not.toThrow();
    expect(() => insert("ev_bad", "made_up")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insert("ev_orphan", "html", "scan_missing")).toThrow(
      /FOREIGN KEY/,
    );
    // Evidence cited by a finding still cannot be deleted.
    expect(() =>
      db.prepare(`DELETE FROM evidence_artifacts WHERE id = 'ev_html'`).run(),
    ).toThrow(/FOREIGN KEY/);
    // Deleting PSI evidence still clears the reference instead of failing.
    db.prepare(`DELETE FROM evidence_artifacts WHERE id = 'ev_psi'`).run();
    expect(
      db
        .prepare(
          `SELECT psi_evidence_artifact_id AS id FROM page_performance_results`,
        )
        .get(),
    ).toEqual({ id: null });
  });
});

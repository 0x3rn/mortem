import {
  PlatformBindingError,
  type D1BoundStatementLike,
  type D1DatabaseLike,
} from "./cloudflare";
import type { DiagnosticCategory, FindingSeverity } from "./index";
import type {
  FindingEffort,
  FindingFixRole,
  FindingImpact,
} from "./schema/scans";

/**
 * Shared writer for check findings (THE-180, THE-181).
 *
 * Each check family owns a `check_id` prefix (`perf.`, `seo.`, …). Writing a
 * family deletes all of that family's findings for the scan and inserts the new
 * set in one D1 batch (a single transaction), so queue redelivery is idempotent
 * and one family can never delete another's findings.
 */

export interface StoredFindingOccurrence {
  pageId: string;
  evidenceArtifactId: string;
  excerpt: string;
  /** Distinguishes several occurrences on the same page (e.g. `mobile`/`desktop`). */
  occurrenceKey?: string;
}

export interface StoredFindingCandidate {
  ruleId: string;
  ruleVersion: string;
  category: DiagnosticCategory;
  severity: FindingSeverity;
  effort: FindingEffort;
  impact: FindingImpact;
  priorityScore: number;
  title: string;
  measured: unknown;
  threshold: unknown;
  fixRole: FindingFixRole;
  occurrences: readonly StoredFindingOccurrence[];
}

export async function executeStatements(
  d1: D1DatabaseLike,
  statements: D1BoundStatementLike[],
): Promise<void> {
  if (statements.length === 0) return;
  if (typeof d1.batch === "function") {
    // D1 batches run as a single transaction.
    await d1.batch(statements);
    return;
  }
  for (const statement of statements) {
    await statement.run();
  }
}

export function wrapDbError(
  action: string,
  err: unknown,
): PlatformBindingError {
  const reason = err instanceof Error ? err.message : "Unknown D1 error";
  return new PlatformBindingError(
    "DATABASE_QUERY_FAILED",
    "DB",
    `Failed to ${action}: ${reason}`,
    { cause: err },
  );
}

const PREFIX_PATTERN = /^[a-z]+\.$/;

/**
 * Replaces every finding of the scan whose `check_id` starts with
 * `checkIdPrefix` (for example `"seo."`) with `candidates`.
 */
export async function replaceFindingsByPrefix(params: {
  d1: D1DatabaseLike;
  scanId: string;
  checkIdPrefix: string;
  candidates: readonly StoredFindingCandidate[];
  nowMs: number;
  /** Used in error messages, e.g. "performance". */
  label: string;
}): Promise<{ findings: number; occurrences: number }> {
  const { d1, scanId, checkIdPrefix, candidates, nowMs } = params;
  if (!PREFIX_PATTERN.test(checkIdPrefix)) {
    throw new Error(`Invalid check id prefix "${checkIdPrefix}"`);
  }
  const foreign = candidates.find((c) => !c.ruleId.startsWith(checkIdPrefix));
  if (foreign) {
    // Writing it would put a finding outside the family this call is allowed to replace.
    throw new Error(
      `Rule ${foreign.ruleId} does not belong to the ${checkIdPrefix} family`,
    );
  }

  const statements: D1BoundStatementLike[] = [
    d1
      .prepare(`DELETE FROM findings WHERE scan_id = ? AND check_id LIKE ?`)
      .bind(scanId, `${checkIdPrefix}%`),
  ];

  let occurrences = 0;
  for (const candidate of candidates) {
    const findingId = `${scanId}_${candidate.ruleId}`;
    statements.push(
      d1
        .prepare(
          `INSERT INTO findings (
             id, scan_id, check_id, check_version, category, severity, effort, impact,
             priority_score, title, measured_value_json, threshold_json, fix_role,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .bind(
          findingId,
          scanId,
          candidate.ruleId,
          candidate.ruleVersion,
          candidate.category,
          candidate.severity,
          candidate.effort,
          candidate.impact,
          candidate.priorityScore,
          candidate.title,
          JSON.stringify(candidate.measured),
          JSON.stringify(candidate.threshold),
          candidate.fixRole,
          nowMs,
          nowMs,
        ),
    );

    const usedIds = new Set<string>();
    for (const occurrence of candidate.occurrences) {
      const base = `${findingId}_${occurrence.pageId}${
        occurrence.occurrenceKey ? `_${occurrence.occurrenceKey}` : ""
      }`;
      let id = base;
      for (let n = 2; usedIds.has(id); n += 1) id = `${base}_${n}`;
      usedIds.add(id);
      occurrences += 1;
      statements.push(
        d1
          .prepare(
            `INSERT INTO finding_occurrences (
               id, finding_id, page_id, evidence_artifact_id, selector, excerpt, bbox_json, created_at
             ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)`,
          )
          .bind(
            id,
            findingId,
            occurrence.pageId,
            occurrence.evidenceArtifactId,
            occurrence.excerpt,
            nowMs,
          ),
      );
    }
  }

  try {
    await executeStatements(d1, statements);
  } catch (err) {
    throw wrapDbError(`write ${params.label} findings`, err);
  }
  return { findings: candidates.length, occurrences };
}

import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { D1DatabaseLike } from "../cloudflare";
import {
  CATEGORY_WEIGHTS,
  DIAGNOSTIC_CATEGORIES,
  type DiagnosticCategory,
  type FindingSeverity,
} from "../index";
import { authSchema, users, workspaces } from "./auth";

export const SCAN_STATUSES = [
  "queued",
  "discovering",
  "capturing",
  "checking",
  "scoring",
  "generating_report",
  "complete",
  "partial",
  "failed",
] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_FAILURE_CLASSES = [
  "ssrf_blocked",
  "dns_resolution_failed",
  "robots_disallowed",
  "navigation_timeout",
  "browser_crash",
  "upstream_blocked",
  "budget_exceeded",
  "internal_error",
] as const;

export type ScanFailureClass = (typeof SCAN_FAILURE_CLASSES)[number];

export const PAGE_TEMPLATE_TYPES = [
  "home",
  "pricing",
  "product",
  "contact",
  "auth",
  "blog",
  "docs",
  "legal",
  "other",
] as const;

export type PageTemplateType = (typeof PAGE_TEMPLATE_TYPES)[number];

export const PAGE_CAPTURE_STATUSES = [
  "pending",
  "captured",
  "partial",
  "failed",
  "skipped",
] as const;

export type PageCaptureStatus = (typeof PAGE_CAPTURE_STATUSES)[number];

export const EVIDENCE_ARTIFACT_KINDS = [
  "html",
  "screenshot_desktop",
  "screenshot_mobile",
  "screenshot_element",
  "headers",
  "network_log",
  "console_log",
  "psi_raw",
  "axe_raw",
  "pdf",
] as const;

export type EvidenceArtifactKind = (typeof EVIDENCE_ARTIFACT_KINDS)[number];

export const FINDING_EFFORTS = ["low", "medium", "high"] as const;
export type FindingEffort = (typeof FINDING_EFFORTS)[number];

export const FINDING_IMPACTS = ["low", "medium", "high", "critical"] as const;
export type FindingImpact = (typeof FINDING_IMPACTS)[number];

export const FINDING_FIX_ROLES = [
  "developer",
  "designer",
  "marketer",
  "content",
  "devops",
] as const;
export type FindingFixRole = (typeof FINDING_FIX_ROLES)[number];

export const FINDING_STATUSES = [
  "open",
  "acknowledged",
  "resolved",
  "ignored",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export interface ScanOptionsJson {
  maxPages?: number;
  viewports?: ("desktop" | "mobile")[];
  includePageSpeed?: boolean;
  includeConversionAnalysis?: boolean;
}

export interface ScanBudgetsJson {
  maxPages?: number;
  maxWallClockMs?: number;
  maxAiInputTokens?: number;
  maxAiOutputTokens?: number;
}

export interface ScanUsageJson {
  pagesDiscovered?: number;
  pagesCaptured?: number;
  browserDurationMs?: number;
  r2BytesWritten?: number;
  psiRequests?: number;
  aiInputTokens?: number;
  aiOutputTokens?: number;
}

export interface RedirectHop {
  fromUrl: string;
  toUrl: string;
  statusCode: number;
}

export interface PageLoadTimingsJson {
  ttfbMs?: number;
  domContentLoadedMs?: number;
  loadEventMs?: number;
  fcpMs?: number;
  lcpMs?: number;
  cls?: number;
  inpMs?: number;
}

export interface BoundingBoxJson {
  x: number;
  y: number;
  width: number;
  height: number;
  viewport: "desktop" | "mobile";
}

export interface MeasuredValueJson {
  metric: string;
  value: number | string | boolean | null;
  unit?: string;
  rawContext?: Record<string, unknown>;
}

export interface ThresholdJson {
  operator: "lt" | "lte" | "gt" | "gte" | "eq" | "neq" | "exists";
  target: number | string | boolean;
  unit?: string;
}

export interface ReportSummaryJson {
  totalPagesCaptured: number;
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  includedCategories: DiagnosticCategory[];
  excludedCategories: {
    category: DiagnosticCategory;
    reason: string;
  }[];
}

export interface ReportAiContentJson {
  executiveDiagnosis?: string;
  topFixes?: {
    findingId: string;
    checkId: string;
    rationale: string;
    steps: string[];
  }[];
  model?: string;
  promptVersion?: string;
}

export const sites = sqliteTable(
  "sites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    displayName: text("display_name").notNull(),
    scheduleCron: text("schedule_cron"),
    scheduleEnabled: integer("schedule_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    lastScannedAt: integer("last_scanned_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_sites_workspace_origin").on(
      table.workspaceId,
      table.origin,
    ),
    index("idx_sites_workspace_id").on(table.workspaceId),
  ],
);

export const scans = sqliteTable(
  "scans",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    targetUrl: text("target_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    status: text("status").$type<ScanStatus>().notNull().default("queued"),
    failureClass: text("failure_class").$type<ScanFailureClass>(),
    failureReason: text("failure_reason"),
    optionsJson: text("options_json").notNull().default("{}"),
    scoringVersion: text("scoring_version").notNull().default("v1.0.0"),
    budgetsJson: text("budgets_json").notNull().default("{}"),
    usageJson: text("usage_json").notNull().default("{}"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_scans_workspace_id").on(table.workspaceId),
    index("idx_scans_site_id").on(table.siteId),
    index("idx_scans_status").on(table.status),
    index("idx_scans_workspace_status").on(table.workspaceId, table.status),
  ],
);

export const scanEvents = sqliteTable(
  "scan_events",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    stage: text("stage").$type<ScanStatus>().notNull(),
    message: text("message").notNull(),
    pagesDiscovered: integer("pages_discovered").notNull().default(0),
    pagesCaptured: integer("pages_captured").notNull().default(0),
    checksCompleted: integer("checks_completed").notNull().default(0),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_scan_events_scan_id").on(table.scanId, table.createdAt),
  ],
);

export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    templateType: text("template_type")
      .$type<PageTemplateType>()
      .notNull()
      .default("other"),
    statusCode: integer("status_code"),
    redirectChainJson: text("redirect_chain_json").notNull().default("[]"),
    loadTimingsJson: text("load_timings_json").notNull().default("{}"),
    captureStatus: text("capture_status")
      .$type<PageCaptureStatus>()
      .notNull()
      .default("pending"),
    failureReason: text("failure_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_pages_scan_id").on(table.scanId),
    index("idx_pages_scan_status").on(table.scanId, table.captureStatus),
    uniqueIndex("idx_pages_scan_normalized_url").on(
      table.scanId,
      table.normalizedUrl,
    ),
  ],
);

export const evidenceArtifacts = sqliteTable(
  "evidence_artifacts",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    pageId: text("page_id").references(() => pages.id, { onDelete: "cascade" }),
    kind: text("kind").$type<EvidenceArtifactKind>().notNull(),
    r2Key: text("r2_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_evidence_artifacts_scan_id").on(table.scanId),
    index("idx_evidence_artifacts_page_id").on(table.pageId),
    index("idx_evidence_artifacts_scan_kind").on(table.scanId, table.kind),
  ],
);

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    checkId: text("check_id").notNull(),
    checkVersion: text("check_version").notNull().default("1.0.0"),
    category: text("category").$type<DiagnosticCategory>().notNull(),
    severity: text("severity").$type<FindingSeverity>().notNull(),
    effort: text("effort").$type<FindingEffort>().notNull(),
    impact: text("impact").$type<FindingImpact>().notNull(),
    priorityScore: real("priority_score").notNull(),
    title: text("title").notNull(),
    measuredValueJson: text("measured_value_json").notNull(),
    thresholdJson: text("threshold_json").notNull(),
    fixRole: text("fix_role").$type<FindingFixRole>().notNull(),
    status: text("status").$type<FindingStatus>().notNull().default("open"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_findings_scan_id").on(table.scanId),
    index("idx_findings_scan_category").on(table.scanId, table.category),
    index("idx_findings_scan_status").on(table.scanId, table.status),
    uniqueIndex("idx_findings_scan_check").on(table.scanId, table.checkId),
  ],
);

export const findingOccurrences = sqliteTable(
  "finding_occurrences",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    evidenceArtifactId: text("evidence_artifact_id")
      .notNull()
      .references(() => evidenceArtifacts.id, { onDelete: "restrict" }),
    selector: text("selector"),
    excerpt: text("excerpt"),
    bboxJson: text("bbox_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_finding_occurrences_finding_id").on(table.findingId),
    index("idx_finding_occurrences_page_id").on(table.pageId),
    index("idx_finding_occurrences_evidence_id").on(table.evidenceArtifactId),
  ],
);

export const scores = sqliteTable(
  "scores",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    category: text("category").$type<DiagnosticCategory>().notNull(),
    score: integer("score"),
    weight: real("weight").notNull(),
    included: integer("included", { mode: "boolean" }).notNull().default(true),
    exclusionReason: text("exclusion_reason"),
    scoringVersion: text("scoring_version").notNull().default("v1.0.0"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_scores_scan_id").on(table.scanId),
    uniqueIndex("idx_scores_scan_category").on(table.scanId, table.category),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .unique()
      .references(() => scans.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scoringVersion: text("scoring_version").notNull().default("v1.0.0"),
    overallScore: integer("overall_score").notNull(),
    summaryJson: text("summary_json").notNull().default("{}"),
    aiContentJson: text("ai_content_json").notNull().default("{}"),
    unlocked: integer("unlocked", { mode: "boolean" }).notNull().default(false),
    pdfArtifactId: text("pdf_artifact_id").references(
      () => evidenceArtifacts.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_reports_workspace_id").on(table.workspaceId),
    uniqueIndex("idx_reports_scan_id").on(table.scanId),
  ],
);

export const reportShares = sqliteTable(
  "report_shares",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    shareToken: text("share_token").notNull().unique(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_report_shares_report_id").on(table.reportId),
    index("idx_report_shares_workspace_id").on(table.workspaceId),
    uniqueIndex("idx_report_shares_token").on(table.shareToken),
  ],
);

export const scanIntakeEvents = sqliteTable(
  "scan_intake_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ipHash: text("ip_hash").notNull(),
    targetHost: text("target_host").notNull(),
    scanId: text("scan_id").references(() => scans.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_scan_intake_events_workspace_created").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("idx_scan_intake_events_ip_created").on(
      table.ipHash,
      table.createdAt,
    ),
    index("idx_scan_intake_events_host_created").on(
      table.targetHost,
      table.createdAt,
    ),
  ],
);

export const scanSchema = {
  sites,
  scans,
  scanEvents,
  pages,
  evidenceArtifacts,
  findings,
  findingOccurrences,
  scores,
  reports,
  reportShares,
  scanIntakeEvents,
};

export const mortemSchema = {
  ...authSchema,
  ...scanSchema,
};

const VALID_SCAN_STATUS_TRANSITIONS: Readonly<
  Record<ScanStatus, readonly ScanStatus[]>
> = {
  queued: ["discovering", "failed"],
  discovering: ["capturing", "partial", "failed"],
  capturing: ["checking", "partial", "failed"],
  checking: ["scoring", "partial", "failed"],
  scoring: ["generating_report", "complete", "partial", "failed"],
  generating_report: ["complete", "partial", "failed"],
  complete: [],
  partial: [],
  failed: [],
};

export function isValidScanStatusTransition(
  from: ScanStatus,
  to: ScanStatus,
): boolean {
  if (from === to) return true;
  return VALID_SCAN_STATUS_TRANSITIONS[from].includes(to);
}

export interface CategoryScoreRecordInput {
  category: DiagnosticCategory;
  score: number | null;
  weight?: number;
  included: boolean;
  exclusionReason?: string | null;
  scoringVersion?: string;
}

export interface ValidatedCategoryScoreRecord {
  category: DiagnosticCategory;
  score: number | null;
  weight: number;
  included: boolean;
  exclusionReason: string | null;
  scoringVersion: string;
}

/**
 * Enforces the provenance rule for category scores:
 * - Included categories (`included = true`) must have an integer `score` in `[0, 100]` and `exclusionReason = null`.
 * - Excluded categories (`included = false`, e.g. partial scans where PSI or capture failed) must have `score = null`
 *   and a non-empty `exclusionReason` — never fake numbers.
 */
export function validateCategoryScoreInput(
  input: CategoryScoreRecordInput,
): ValidatedCategoryScoreRecord {
  if (!DIAGNOSTIC_CATEGORIES.includes(input.category)) {
    throw new Error(`Invalid diagnostic category: ${String(input.category)}`);
  }

  const weight = input.weight ?? CATEGORY_WEIGHTS[input.category];
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error(
      `Category weight for '${input.category}' must be between 0 and 1.`,
    );
  }

  const scoringVersion = input.scoringVersion?.trim() || "v1.0.0";

  if (input.included) {
    if (
      typeof input.score !== "number" ||
      !Number.isInteger(input.score) ||
      input.score < 0 ||
      input.score > 100
    ) {
      throw new Error(
        `Included category '${input.category}' requires an integer score in [0, 100].`,
      );
    }
    if (input.exclusionReason && input.exclusionReason.trim().length > 0) {
      throw new Error(
        `Included category '${input.category}' cannot specify an exclusionReason.`,
      );
    }
    return {
      category: input.category,
      score: input.score,
      weight,
      included: true,
      exclusionReason: null,
      scoringVersion,
    };
  }

  if (input.score !== null && input.score !== undefined) {
    throw new Error(
      `Excluded category '${input.category}' must have score = null (never store fabricated scores).`,
    );
  }

  const trimmedReason = input.exclusionReason?.trim() ?? "";
  if (!trimmedReason) {
    throw new Error(
      `Excluded category '${input.category}' requires a non-empty exclusionReason.`,
    );
  }

  return {
    category: input.category,
    score: null,
    weight,
    included: false,
    exclusionReason: trimmedReason,
    scoringVersion,
  };
}

/**
 * Computes the normalized weighted overall score `[0, 100]` across all `included` categories.
 * Re-normalizes weights across included categories when a scan completes in `partial` mode.
 */
export function computeWeightedOverallScore(
  records: readonly ValidatedCategoryScoreRecord[],
): number {
  const includedRecords = records.filter(
    (record): record is ValidatedCategoryScoreRecord & { score: number } =>
      record.included && typeof record.score === "number",
  );

  if (includedRecords.length === 0) {
    throw new Error(
      "Cannot compute overall score when zero categories are included.",
    );
  }

  const totalIncludedWeight = includedRecords.reduce(
    (sum, record) => sum + record.weight,
    0,
  );
  if (totalIncludedWeight <= 0) {
    throw new Error("Total weight of included categories must be positive.");
  }

  const weightedSum = includedRecords.reduce(
    (sum, record) => sum + record.score * record.weight,
    0,
  );

  return Math.round(weightedSum / totalIncludedWeight);
}

export interface DeterministicScanFixtureOptions {
  workspaceId: string;
  mode?: "complete" | "partial";
  scanId?: string;
  siteId?: string;
  reportId?: string;
  nowMs?: number;
}

export interface DeterministicScanFixture {
  site: {
    id: string;
    workspaceId: string;
    origin: string;
    displayName: string;
    scheduleCron: string | null;
    scheduleEnabled: boolean;
    lastScannedAt: number;
    createdAt: number;
    updatedAt: number;
  };
  scan: {
    id: string;
    workspaceId: string;
    siteId: string;
    targetUrl: string;
    normalizedUrl: string;
    status: ScanStatus;
    failureClass: ScanFailureClass | null;
    failureReason: string | null;
    optionsJson: string;
    scoringVersion: string;
    budgetsJson: string;
    usageJson: string;
    startedAt: number;
    completedAt: number;
    createdAt: number;
    updatedAt: number;
  };
  events: {
    id: string;
    scanId: string;
    stage: ScanStatus;
    message: string;
    pagesDiscovered: number;
    pagesCaptured: number;
    checksCompleted: number;
    metadataJson: string;
    createdAt: number;
  }[];
  pages: {
    id: string;
    scanId: string;
    url: string;
    normalizedUrl: string;
    templateType: PageTemplateType;
    statusCode: number;
    redirectChainJson: string;
    loadTimingsJson: string;
    captureStatus: PageCaptureStatus;
    failureReason: string | null;
    createdAt: number;
    updatedAt: number;
  }[];
  evidenceArtifacts: {
    id: string;
    scanId: string;
    pageId: string;
    kind: EvidenceArtifactKind;
    r2Key: string;
    byteSize: number;
    sha256: string;
    metadataJson: string;
    createdAt: number;
  }[];
  findings: {
    id: string;
    scanId: string;
    checkId: string;
    checkVersion: string;
    category: DiagnosticCategory;
    severity: FindingSeverity;
    effort: FindingEffort;
    impact: FindingImpact;
    priorityScore: number;
    title: string;
    measuredValueJson: string;
    thresholdJson: string;
    fixRole: FindingFixRole;
    status: FindingStatus;
    createdAt: number;
    updatedAt: number;
  }[];
  findingOccurrences: {
    id: string;
    findingId: string;
    pageId: string;
    evidenceArtifactId: string;
    selector: string;
    excerpt: string;
    bboxJson: string;
    createdAt: number;
  }[];
  scores: (ValidatedCategoryScoreRecord & {
    id: string;
    scanId: string;
    createdAt: number;
  })[];
  report: {
    id: string;
    scanId: string;
    workspaceId: string;
    scoringVersion: string;
    overallScore: number;
    summaryJson: string;
    aiContentJson: string;
    unlocked: boolean;
    pdfArtifactId: string | null;
    createdAt: number;
    updatedAt: number;
  };
}

/**
 * Builds a deterministic, evidence-backed scan fixture (`complete` or `partial`)
 * for unit and integration testing across crawler, diagnostic, scoring, and report modules.
 */
export function createDeterministicScanFixture(
  options: DeterministicScanFixtureOptions,
): DeterministicScanFixture {
  const mode = options.mode ?? "complete";
  const nowMs = options.nowMs ?? Date.UTC(2026, 9, 14, 2, 0, 0);
  const siteId = options.siteId ?? "site_fixture_acme";
  const scanId =
    options.scanId ??
    (mode === "complete" ? "scan_fixture_complete" : "scan_fixture_partial");
  const reportId =
    options.reportId ??
    (mode === "complete" ? "rpt_fixture_complete" : "rpt_fixture_partial");

  const homePageId = `${scanId}_page_home`;
  const pricingPageId = `${scanId}_page_pricing`;
  const htmlEvidenceId = `${scanId}_ev_html_home`;
  const desktopShotEvidenceId = `${scanId}_ev_shot_pricing`;
  const findingLcpId = `${scanId}_finding_perf_lcp`;
  const findingCtaId = `${scanId}_finding_conv_cta`;

  const rawScoreInputs: CategoryScoreRecordInput[] = [
    {
      category: "performance",
      score: mode === "complete" ? 64 : null,
      included: mode === "complete",
      exclusionReason:
        mode === "complete"
          ? null
          : "PageSpeed Insights upstream timed out after 15000ms",
    },
    { category: "conversion", score: 58, included: true },
    { category: "seo", score: 82, included: true },
    { category: "accessibility", score: 76, included: true },
    { category: "mobile", score: 71, included: true },
    { category: "security", score: 90, included: true },
    { category: "links_assets", score: 88, included: true },
  ];

  const validatedScores = rawScoreInputs.map((item) => {
    const validated = validateCategoryScoreInput(item);
    return {
      id: `${scanId}_score_${item.category}`,
      scanId,
      ...validated,
      createdAt: nowMs,
    };
  });

  const overallScore = computeWeightedOverallScore(validatedScores);

  const summary: ReportSummaryJson = {
    totalPagesCaptured: 2,
    totalFindings: 2,
    criticalCount: 1,
    highCount: 1,
    mediumCount: 0,
    lowCount: 0,
    includedCategories: validatedScores
      .filter((s) => s.included)
      .map((s) => s.category),
    excludedCategories: validatedScores
      .filter((s) => !s.included && s.exclusionReason)
      .map((s) => ({
        category: s.category,
        reason: s.exclusionReason as string,
      })),
  };

  return {
    site: {
      id: siteId,
      workspaceId: options.workspaceId,
      origin: "https://acme-cloud.io",
      displayName: "acme-cloud.io",
      scheduleCron: "0 9 * * 1",
      scheduleEnabled: true,
      lastScannedAt: nowMs,
      createdAt: nowMs - 60_000,
      updatedAt: nowMs,
    },
    scan: {
      id: scanId,
      workspaceId: options.workspaceId,
      siteId,
      targetUrl: "acme-cloud.io",
      normalizedUrl: "https://acme-cloud.io/",
      status: mode,
      failureClass: mode === "partial" ? "navigation_timeout" : null,
      failureReason:
        mode === "partial"
          ? "PageSpeed Insights upstream timed out on mobile strategy"
          : null,
      optionsJson: JSON.stringify({
        maxPages: 5,
        viewports: ["desktop", "mobile"],
      } satisfies ScanOptionsJson),
      scoringVersion: "v1.0.0",
      budgetsJson: JSON.stringify({
        maxPages: 10,
        maxWallClockMs: 60_000,
      } satisfies ScanBudgetsJson),
      usageJson: JSON.stringify({
        pagesDiscovered: 2,
        pagesCaptured: 2,
        browserDurationMs: 4120,
        r2BytesWritten: 184_320,
      } satisfies ScanUsageJson),
      startedAt: nowMs - 12_000,
      completedAt: nowMs,
      createdAt: nowMs - 15_000,
      updatedAt: nowMs,
    },
    events: [
      {
        id: `${scanId}_evt_1`,
        scanId,
        stage: "queued",
        message: "Scan job queued for https://acme-cloud.io/",
        pagesDiscovered: 0,
        pagesCaptured: 0,
        checksCompleted: 0,
        metadataJson: "{}",
        createdAt: nowMs - 15_000,
      },
      {
        id: `${scanId}_evt_2`,
        scanId,
        stage: mode,
        message:
          mode === "complete"
            ? "Scan completed across 2 pages and 7 categories."
            : "Scan completed partially (6/7 categories scored; performance excluded).",
        pagesDiscovered: 2,
        pagesCaptured: 2,
        checksCompleted: 14,
        metadataJson: "{}",
        createdAt: nowMs,
      },
    ],
    pages: [
      {
        id: homePageId,
        scanId,
        url: "https://acme-cloud.io/",
        normalizedUrl: "https://acme-cloud.io/",
        templateType: "home",
        statusCode: 200,
        redirectChainJson: JSON.stringify([] satisfies RedirectHop[]),
        loadTimingsJson: JSON.stringify({
          ttfbMs: 210,
          fcpMs: 1180,
          lcpMs: 3920,
          cls: 0.04,
        } satisfies PageLoadTimingsJson),
        captureStatus: "captured",
        failureReason: null,
        createdAt: nowMs - 10_000,
        updatedAt: nowMs - 8_000,
      },
      {
        id: pricingPageId,
        scanId,
        url: "https://acme-cloud.io/pricing",
        normalizedUrl: "https://acme-cloud.io/pricing",
        templateType: "pricing",
        statusCode: 200,
        redirectChainJson: JSON.stringify([] satisfies RedirectHop[]),
        loadTimingsJson: JSON.stringify({
          ttfbMs: 185,
          fcpMs: 990,
          lcpMs: 2410,
          cls: 0.01,
        } satisfies PageLoadTimingsJson),
        captureStatus: "captured",
        failureReason: null,
        createdAt: nowMs - 9_000,
        updatedAt: nowMs - 6_000,
      },
    ],
    evidenceArtifacts: [
      {
        id: htmlEvidenceId,
        scanId,
        pageId: homePageId,
        kind: "html",
        r2Key: `scans/${scanId}/pages/${homePageId}/rendered.html`,
        byteSize: 42_810,
        sha256:
          "a3f5c8e91b204d67890123456789abcdef0123456789abcdef0123456789abcd",
        metadataJson: JSON.stringify({
          contentType: "text/html; charset=utf-8",
        }),
        createdAt: nowMs - 8_000,
      },
      {
        id: desktopShotEvidenceId,
        scanId,
        pageId: pricingPageId,
        kind: "screenshot_desktop",
        r2Key: `scans/${scanId}/pages/${pricingPageId}/desktop.png`,
        byteSize: 141_510,
        sha256:
          "b4e6d9f02c315e7890123456789abcdef0123456789abcdef0123456789abcde",
        metadataJson: JSON.stringify({ width: 1440, height: 900 }),
        createdAt: nowMs - 6_000,
      },
    ],
    findings: [
      {
        id: findingLcpId,
        scanId,
        checkId: "perf.lcp.slow-hero-image",
        checkVersion: "1.0.0",
        category: "performance",
        severity: "high",
        effort: "low",
        impact: "high",
        priorityScore: 86.5,
        title: "Hero image Largest Contentful Paint exceeds 2.5s budget",
        measuredValueJson: JSON.stringify({
          metric: "lcpMs",
          value: 3920,
          unit: "ms",
        } satisfies MeasuredValueJson),
        thresholdJson: JSON.stringify({
          operator: "lte",
          target: 2500,
          unit: "ms",
        } satisfies ThresholdJson),
        fixRole: "developer",
        status: "open",
        createdAt: nowMs - 4_000,
        updatedAt: nowMs - 4_000,
      },
      {
        id: findingCtaId,
        scanId,
        checkId: "conv.cta.missing-above-fold-pricing-action",
        checkVersion: "1.0.0",
        category: "conversion",
        severity: "critical",
        effort: "medium",
        impact: "critical",
        priorityScore: 94.0,
        title: "Primary pricing tier lacks an above-the-fold checkout CTA",
        measuredValueJson: JSON.stringify({
          metric: "aboveFoldPrimaryCtaCount",
          value: 0,
        } satisfies MeasuredValueJson),
        thresholdJson: JSON.stringify({
          operator: "gte",
          target: 1,
        } satisfies ThresholdJson),
        fixRole: "designer",
        status: "open",
        createdAt: nowMs - 3_000,
        updatedAt: nowMs - 3_000,
      },
    ],
    findingOccurrences: [
      {
        id: `${scanId}_occ_lcp_home`,
        findingId: findingLcpId,
        pageId: homePageId,
        evidenceArtifactId: htmlEvidenceId,
        selector: "main > section.hero > img.hero-banner",
        excerpt: '<img class="hero-banner" src="/hero-unoptimized.png">',
        bboxJson: JSON.stringify({
          x: 120,
          y: 164,
          width: 1200,
          height: 540,
          viewport: "desktop",
        } satisfies BoundingBoxJson),
        createdAt: nowMs - 4_000,
      },
      {
        id: `${scanId}_occ_cta_pricing`,
        findingId: findingCtaId,
        pageId: pricingPageId,
        evidenceArtifactId: desktopShotEvidenceId,
        selector: "section#pricing-tiers > div.tier-pro",
        excerpt: '<div class="tier-pro"><h3>Pro</h3><p>$49/mo</p></div>',
        bboxJson: JSON.stringify({
          x: 480,
          y: 940,
          width: 360,
          height: 420,
          viewport: "desktop",
        } satisfies BoundingBoxJson),
        createdAt: nowMs - 3_000,
      },
    ],
    scores: validatedScores,
    report: {
      id: reportId,
      scanId,
      workspaceId: options.workspaceId,
      scoringVersion: "v1.0.0",
      overallScore,
      summaryJson: JSON.stringify(summary),
      aiContentJson: JSON.stringify({
        executiveDiagnosis:
          "Primary conversion friction on /pricing and unoptimized LCP media on / are suppressing trial signups.",
        model: "workers-ai-llama-3.3-70b",
        promptVersion: "v1.0.0",
      } satisfies ReportAiContentJson),
      unlocked: true,
      pdfArtifactId: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    },
  };
}

/**
 * Inserts a `DeterministicScanFixture` into a D1 database (`--local` or in-memory SQLite test harness).
 */
export async function seedDeterministicScanFixture(
  d1: D1DatabaseLike,
  fixture: DeterministicScanFixture,
): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO sites (
        id, workspace_id, origin, display_name, schedule_cron, schedule_enabled, last_scanned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fixture.site.id,
      fixture.site.workspaceId,
      fixture.site.origin,
      fixture.site.displayName,
      fixture.site.scheduleCron,
      fixture.site.scheduleEnabled ? 1 : 0,
      fixture.site.lastScannedAt,
      fixture.site.createdAt,
      fixture.site.updatedAt,
    )
    .run();

  await d1
    .prepare(
      `INSERT INTO scans (
        id, workspace_id, site_id, target_url, normalized_url, status, failure_class, failure_reason,
        options_json, scoring_version, budgets_json, usage_json, started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fixture.scan.id,
      fixture.scan.workspaceId,
      fixture.scan.siteId,
      fixture.scan.targetUrl,
      fixture.scan.normalizedUrl,
      fixture.scan.status,
      fixture.scan.failureClass,
      fixture.scan.failureReason,
      fixture.scan.optionsJson,
      fixture.scan.scoringVersion,
      fixture.scan.budgetsJson,
      fixture.scan.usageJson,
      fixture.scan.startedAt,
      fixture.scan.completedAt,
      fixture.scan.createdAt,
      fixture.scan.updatedAt,
    )
    .run();

  for (const evt of fixture.events) {
    await d1
      .prepare(
        `INSERT INTO scan_events (
          id, scan_id, stage, message, pages_discovered, pages_captured, checks_completed, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        evt.id,
        evt.scanId,
        evt.stage,
        evt.message,
        evt.pagesDiscovered,
        evt.pagesCaptured,
        evt.checksCompleted,
        evt.metadataJson,
        evt.createdAt,
      )
      .run();
  }

  for (const page of fixture.pages) {
    await d1
      .prepare(
        `INSERT INTO pages (
          id, scan_id, url, normalized_url, template_type, status_code, redirect_chain_json,
          load_timings_json, capture_status, failure_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        page.id,
        page.scanId,
        page.url,
        page.normalizedUrl,
        page.templateType,
        page.statusCode,
        page.redirectChainJson,
        page.loadTimingsJson,
        page.captureStatus,
        page.failureReason,
        page.createdAt,
        page.updatedAt,
      )
      .run();
  }

  for (const artifact of fixture.evidenceArtifacts) {
    await d1
      .prepare(
        `INSERT INTO evidence_artifacts (
          id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        artifact.id,
        artifact.scanId,
        artifact.pageId,
        artifact.kind,
        artifact.r2Key,
        artifact.byteSize,
        artifact.sha256,
        artifact.metadataJson,
        artifact.createdAt,
      )
      .run();
  }

  for (const finding of fixture.findings) {
    await d1
      .prepare(
        `INSERT INTO findings (
          id, scan_id, check_id, check_version, category, severity, effort, impact,
          priority_score, title, measured_value_json, threshold_json, fix_role, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        finding.id,
        finding.scanId,
        finding.checkId,
        finding.checkVersion,
        finding.category,
        finding.severity,
        finding.effort,
        finding.impact,
        finding.priorityScore,
        finding.title,
        finding.measuredValueJson,
        finding.thresholdJson,
        finding.fixRole,
        finding.status,
        finding.createdAt,
        finding.updatedAt,
      )
      .run();
  }

  for (const occ of fixture.findingOccurrences) {
    await d1
      .prepare(
        `INSERT INTO finding_occurrences (
          id, finding_id, page_id, evidence_artifact_id, selector, excerpt, bbox_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        occ.id,
        occ.findingId,
        occ.pageId,
        occ.evidenceArtifactId,
        occ.selector,
        occ.excerpt,
        occ.bboxJson,
        occ.createdAt,
      )
      .run();
  }

  for (const scoreRow of fixture.scores) {
    await d1
      .prepare(
        `INSERT INTO scores (
          id, scan_id, category, score, weight, included, exclusion_reason, scoring_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        scoreRow.id,
        scoreRow.scanId,
        scoreRow.category,
        scoreRow.score,
        scoreRow.weight,
        scoreRow.included ? 1 : 0,
        scoreRow.exclusionReason,
        scoreRow.scoringVersion,
        scoreRow.createdAt,
      )
      .run();
  }

  await d1
    .prepare(
      `INSERT INTO reports (
        id, scan_id, workspace_id, scoring_version, overall_score, summary_json,
        ai_content_json, unlocked, pdf_artifact_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fixture.report.id,
      fixture.report.scanId,
      fixture.report.workspaceId,
      fixture.report.scoringVersion,
      fixture.report.overallScore,
      fixture.report.summaryJson,
      fixture.report.aiContentJson,
      fixture.report.unlocked ? 1 : 0,
      fixture.report.pdfArtifactId,
      fixture.report.createdAt,
      fixture.report.updatedAt,
    )
    .run();
}

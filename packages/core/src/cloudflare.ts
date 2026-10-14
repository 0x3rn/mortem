/**
 * Cloudflare platform binding contracts, fail-closed validators, and smoke artifact helpers.
 * Never falls back to fabricated or mock data when bindings or storage operations fail.
 */

export type PlatformBindingName =
  "DB" | "EVIDENCE" | "SCAN_QUEUE" | "SCAN_DLQ" | "BROWSER";

export type PlatformErrorCode =
  | "MISSING_BINDING"
  | "DATABASE_QUERY_FAILED"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_READ_FAILED"
  | "QUEUE_SEND_FAILED"
  | "BROWSER_RENDER_FAILED";

export class PlatformBindingError extends Error {
  readonly code: PlatformErrorCode;
  readonly bindingName: PlatformBindingName;

  constructor(
    code: PlatformErrorCode,
    bindingName: PlatformBindingName,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PlatformBindingError";
    this.code = code;
    this.bindingName = bindingName;
  }
}

export interface D1ExecResultLike<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
}

export interface D1BoundStatementLike {
  run(): Promise<D1ExecResultLike>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all?<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1BoundStatementLike;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?(statements: D1BoundStatementLike[]): Promise<D1ExecResultLike[]>;
}

export interface R2ObjectMetaLike {
  key: string;
  size: number;
  etag?: string;
}

export interface R2PutOptionsLike {
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectMetaLike {
  body?: ReadableStream<Uint8Array>;
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectMetaLike | null>;
  head(key: string): Promise<R2ObjectMetaLike | null>;
  get?(key: string): Promise<R2ObjectBodyLike | null>;
}

export interface QueueLike<T = unknown> {
  send(message: T): Promise<void>;
}

export interface BrowserBindingLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface MortemWebBindings {
  ENVIRONMENT?: string;
  MORTEM_ADMIN_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  MORTEM_EMAIL_FROM?: string;
  DB?: D1DatabaseLike;
  EVIDENCE?: R2BucketLike;
  SCAN_QUEUE?: QueueLike;
  SCAN_DLQ?: QueueLike;
}

export interface ValidatedMortemWebBindings {
  ENVIRONMENT: string;
  MORTEM_ADMIN_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  MORTEM_EMAIL_FROM?: string;
  DB: D1DatabaseLike;
  EVIDENCE: R2BucketLike;
  SCAN_QUEUE: QueueLike;
  SCAN_DLQ?: QueueLike;
}

export interface MortemScanBindings {
  ENVIRONMENT?: string;
  DB?: D1DatabaseLike;
  EVIDENCE?: R2BucketLike;
  BROWSER?: BrowserBindingLike;
  SCAN_QUEUE?: QueueLike;
  SCAN_DLQ?: QueueLike;
}

export interface ValidatedMortemScanBindings {
  ENVIRONMENT: string;
  DB: D1DatabaseLike;
  EVIDENCE: R2BucketLike;
  BROWSER?: BrowserBindingLike;
  SCAN_QUEUE?: QueueLike;
  SCAN_DLQ?: QueueLike;
}

export interface PlatformSmokeRow {
  id: string;
  target_url: string;
  status: "queued" | "completed" | "failed";
  r2_object_key: string | null;
  r2_byte_size: number | null;
  browser_title: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export function requireWebBindings(
  env: MortemWebBindings | null | undefined,
): ValidatedMortemWebBindings {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "DB",
      "Cloudflare D1 binding 'DB' is not configured on mortem-web.",
    );
  }
  if (!env?.EVIDENCE || typeof env.EVIDENCE.put !== "function") {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "EVIDENCE",
      "Cloudflare R2 binding 'EVIDENCE' is not configured on mortem-web.",
    );
  }
  if (!env?.SCAN_QUEUE || typeof env.SCAN_QUEUE.send !== "function") {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "SCAN_QUEUE",
      "Cloudflare Queue binding 'SCAN_QUEUE' is not configured on mortem-web.",
    );
  }

  return {
    ENVIRONMENT: env.ENVIRONMENT ?? "development",
    MORTEM_ADMIN_SECRET: env.MORTEM_ADMIN_SECRET,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    RESEND_API_KEY: env.RESEND_API_KEY,
    MORTEM_EMAIL_FROM: env.MORTEM_EMAIL_FROM,
    DB: env.DB,
    EVIDENCE: env.EVIDENCE,
    SCAN_QUEUE: env.SCAN_QUEUE,
    SCAN_DLQ: env.SCAN_DLQ,
  };
}

export function requireScanWorkerBindings(
  env: MortemScanBindings | null | undefined,
  options: { requireBrowser?: boolean } = {},
): ValidatedMortemScanBindings {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "DB",
      "Cloudflare D1 binding 'DB' is not configured on mortem-scan.",
    );
  }
  if (!env?.EVIDENCE || typeof env.EVIDENCE.put !== "function") {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "EVIDENCE",
      "Cloudflare R2 binding 'EVIDENCE' is not configured on mortem-scan.",
    );
  }
  if (
    options.requireBrowser &&
    (!env?.BROWSER || typeof env.BROWSER.fetch !== "function")
  ) {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "BROWSER",
      "Cloudflare Browser Rendering binding 'BROWSER' is not configured on mortem-scan.",
    );
  }

  return {
    ENVIRONMENT: env.ENVIRONMENT ?? "development",
    DB: env.DB,
    EVIDENCE: env.EVIDENCE,
    BROWSER: env.BROWSER,
    SCAN_QUEUE: env.SCAN_QUEUE,
    SCAN_DLQ: env.SCAN_DLQ,
  };
}

export function buildSmokeArtifactKey(smokeId: string): string {
  const safeId = smokeId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `scans/smoke-${safeId}/pages/example-com/screenshot.png`;
}

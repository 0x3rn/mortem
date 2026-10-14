import type { D1DatabaseLike } from "./cloudflare";

export const EMAIL_OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes (300,000 ms)
export const EMAIL_OTP_TTL_SECONDS = 300;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;

export type EmailOtpMode = "sign-up" | "sign-in";

export type EmailOtpErrorCode =
  | "invalid_input"
  | "turnstile_failed"
  | "email_already_registered"
  | "invalid_credentials"
  | "otp_not_found"
  | "otp_expired"
  | "otp_invalid"
  | "otp_max_attempts"
  | "email_delivery_failed";

export class EmailOtpError extends Error {
  readonly code: EmailOtpErrorCode;
  readonly httpStatus: number;

  constructor(code: EmailOtpErrorCode, message: string, httpStatus = 400) {
    super(message);
    this.name = "EmailOtpError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface IssuedEmailOtpChallenge {
  verificationId: string;
  email: string;
  mode: EmailOtpMode;
  code: string;
  expiresAt: number;
  ttlSeconds: number;
}

export interface StoredOtpValueJson {
  codeHash: string;
  attempts: number;
  issuedAt: number;
}

function buildOtpIdentifier(mode: EmailOtpMode, email: string): string {
  return `mortem_otp:${mode}:${email.trim().toLowerCase()}`;
}

export function generateSixDigitOtpCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const num = 100_000 + ((array[0] ?? 0) % 900_000);
  return String(num).padStart(6, "0");
}

export async function hashOtpCode(
  email: string,
  mode: EmailOtpMode,
  code: string,
): Promise<string> {
  const canonical = `${mode}:${email.trim().toLowerCase()}:${code.trim()}`;
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Issues a new 6-digit email verification code that expires in exactly 5 minutes (`300,000` ms).
 * Automatically deletes any prior code for the same `(mode, email)` so previous codes are immediately invalidated.
 */
export async function issueEmailOtpChallenge(
  d1: D1DatabaseLike,
  params: {
    email: string;
    mode: EmailOtpMode;
    codeOverride?: string;
    nowMs?: number;
  },
): Promise<IssuedEmailOtpChallenge> {
  const nowMs = params.nowMs ?? Date.now();
  const normalizedEmail = params.email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new EmailOtpError(
      "invalid_input",
      "Enter a valid email address.",
      422,
    );
  }

  const identifier = buildOtpIdentifier(params.mode, normalizedEmail);
  const code = params.codeOverride ?? generateSixDigitOtpCode();
  const codeHash = await hashOtpCode(normalizedEmail, params.mode, code);
  const expiresAt = nowMs + EMAIL_OTP_TTL_MS;
  const verificationId = `otp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  // Invalidate any previous OTP for this (mode, email) and clean up expired OTP rows
  await d1
    .prepare(
      `DELETE FROM verifications
       WHERE identifier = ?
          OR (identifier LIKE 'mortem_otp:%' AND expires_at <= ?)`,
    )
    .bind(identifier, nowMs)
    .run();

  const payload: StoredOtpValueJson = {
    codeHash,
    attempts: 0,
    issuedAt: nowMs,
  };

  await d1
    .prepare(
      `INSERT INTO verifications (
        id, identifier, value, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      verificationId,
      identifier,
      JSON.stringify(payload),
      expiresAt,
      nowMs,
      nowMs,
    )
    .run();

  return {
    verificationId,
    email: normalizedEmail,
    mode: params.mode,
    code,
    expiresAt,
    ttlSeconds: EMAIL_OTP_TTL_SECONDS,
  };
}

/**
 * Verifies a 6-digit email confirmation code.
 * - Rejects and deletes the code if more than 5 minutes (`300,000` ms) have elapsed (`otp_expired`).
 * - Tracks failed attempts and invalidates the code on brute-force attempts (`otp_max_attempts`).
 * - Immediately deletes the code upon successful verification so it can never be reused.
 */
export async function verifyEmailOtpChallenge(
  d1: D1DatabaseLike,
  params: {
    email: string;
    mode: EmailOtpMode;
    code: string;
    nowMs?: number;
  },
): Promise<{ verified: true; email: string; mode: EmailOtpMode }> {
  const nowMs = params.nowMs ?? Date.now();
  const normalizedEmail = params.email.trim().toLowerCase();
  const trimmedCode = params.code.trim();

  if (!/^\d{6}$/.test(trimmedCode)) {
    throw new EmailOtpError(
      "otp_invalid",
      "Enter the 6-digit verification code sent to your email.",
      422,
    );
  }

  const identifier = buildOtpIdentifier(params.mode, normalizedEmail);
  const row = await d1
    .prepare(
      `SELECT id, value, expires_at
       FROM verifications
       WHERE identifier = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(identifier)
    .first<{ id: string; value: string; expires_at: number }>();

  if (!row) {
    throw new EmailOtpError(
      "otp_not_found",
      "No active verification code found. Please request a new code.",
      404,
    );
  }

  const expiresAtMs = Number(row.expires_at);
  if (nowMs > expiresAtMs) {
    await d1
      .prepare(`DELETE FROM verifications WHERE id = ?`)
      .bind(row.id)
      .run();
    throw new EmailOtpError(
      "otp_expired",
      "Verification code has expired (codes are valid for 5 minutes). Please request a new code.",
      410,
    );
  }

  let stored: StoredOtpValueJson;
  try {
    stored = JSON.parse(row.value) as StoredOtpValueJson;
  } catch {
    await d1
      .prepare(`DELETE FROM verifications WHERE id = ?`)
      .bind(row.id)
      .run();
    throw new EmailOtpError(
      "otp_not_found",
      "Verification state is invalid. Please request a new code.",
      404,
    );
  }

  if (stored.attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
    await d1
      .prepare(`DELETE FROM verifications WHERE id = ?`)
      .bind(row.id)
      .run();
    throw new EmailOtpError(
      "otp_max_attempts",
      "Too many incorrect attempts. This code has been invalidated — please request a new code.",
      429,
    );
  }

  const candidateHash = await hashOtpCode(
    normalizedEmail,
    params.mode,
    trimmedCode,
  );

  if (candidateHash !== stored.codeHash) {
    const nextAttempts = stored.attempts + 1;
    if (nextAttempts >= EMAIL_OTP_MAX_ATTEMPTS) {
      await d1
        .prepare(`DELETE FROM verifications WHERE id = ?`)
        .bind(row.id)
        .run();
      throw new EmailOtpError(
        "otp_max_attempts",
        "Too many incorrect attempts. This code has been invalidated — please request a new code.",
        429,
      );
    }

    await d1
      .prepare(
        `UPDATE verifications
         SET value = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        JSON.stringify({
          ...stored,
          attempts: nextAttempts,
        }),
        nowMs,
        row.id,
      )
      .run();

    throw new EmailOtpError(
      "otp_invalid",
      "Invalid verification code. Please check the 6-digit code and try again.",
      422,
    );
  }

  // Code matched within the 5-minute window: consume & delete immediately
  await d1.prepare(`DELETE FROM verifications WHERE id = ?`).bind(row.id).run();

  return {
    verified: true,
    email: normalizedEmail,
    mode: params.mode,
  };
}

export interface SendOtpEmailViaResendOptions {
  apiKey: string;
  fromEmail: string;
  toEmail: string;
  code: string;
  mode: EmailOtpMode;
  fetchFn?: typeof fetch;
}

export async function sendOtpEmailViaResend(
  options: SendOtpEmailViaResendOptions,
): Promise<{ id: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const actionLabel =
    options.mode === "sign-up"
      ? "confirm your new Mortem workspace"
      : "complete your Mortem sign-in";

  const fromField = options.fromEmail.includes("<")
    ? options.fromEmail
    : `Mortem <${options.fromEmail}>`;

  const response = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromField,
      to: [options.toEmail],
      subject: `${options.code} is your Mortem verification code`,
      text: `Your Mortem verification code to ${actionLabel} is: ${options.code}\n\nThis code expires in 5 minutes. If you did not request this code, you can safely ignore this email.`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0b0d10; color: #f3f4f6; border-radius: 12px; border: 1px solid #1f242d;">
          <p style="font-family: monospace; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #f97316; margin: 0 0 8px;">Mortem Security Verification</p>
          <h1 style="font-size: 20px; font-weight: 700; margin: 0 0 12px; color: #ffffff;">Confirm your email address</h1>
          <p style="font-size: 14px; line-height: 1.6; color: #9ca3af; margin: 0 0 24px;">
            Enter the 6-digit verification code below to ${actionLabel}. This code is valid for <strong>5 minutes</strong>.
          </p>
          <div style="background: #131720; border: 1px solid #2a313d; border-radius: 8px; padding: 18px; text-align: center; margin: 0 0 24px;">
            <span style="font-family: monospace; font-size: 32px; font-weight: 700; letter-spacing: 0.25em; color: #ffffff;">${options.code}</span>
          </div>
          <p style="font-size: 12px; line-height: 1.5; color: #6b7280; margin: 0;">
            If you did not request this code, no action is needed and your account remains secure.
          </p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new EmailOtpError(
      "email_delivery_failed",
      `Unable to send verification email (${response.status}): ${errBody || response.statusText}`,
      502,
    );
  }

  const data = (await response.json().catch(() => ({}))) as { id?: string };
  return { id: data.id ?? "sent" };
}

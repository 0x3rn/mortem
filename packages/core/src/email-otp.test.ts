import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1ExecResultLike,
} from "./cloudflare";
import {
  EMAIL_OTP_TTL_MS,
  EmailOtpError,
  issueEmailOtpChallenge,
  sendOtpEmailViaResend,
  verifyEmailOtpChallenge,
} from "./index";

const MIGRATION_0001_SQL = readFileSync(
  join(__dirname, "../migrations/0001_auth_and_workspaces.sql"),
  "utf8",
);

function createSqliteD1(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(MIGRATION_0001_SQL);

  function createBound(
    query: string,
    params: unknown[],
  ): D1BoundStatementLike & { raw?: () => Promise<unknown[][]> } {
    const normalized = params.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v.getTime();
      return v as SQLInputValue;
    });
    return {
      async run(): Promise<D1ExecResultLike> {
        const stmt = sqlite.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalized) as Record<string, unknown>[];
          return { success: true, results: rows };
        }
        stmt.run(...normalized);
        return { success: true, results: [] };
      },
      async first<T = Record<string, unknown>>(
        col?: string,
      ): Promise<T | null> {
        const row = sqlite.prepare(query).get(...normalized) as
          Record<string, unknown> | undefined;
        if (!row) return null;
        if (col) return (row[col] as T) ?? null;
        return row as T;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const stmt = sqlite.prepare(query);
        const rows = stmt.all(...normalized) as T[];
        return { success: true, results: rows };
      },
    };
  }

  return {
    prepare(query: string) {
      const def = createBound(query, []);
      return {
        ...def,
        bind(...values: unknown[]) {
          return createBound(query, values);
        },
      };
    },
  };
}

describe("5-minute Email OTP verification & Resend delivery", () => {
  it("issues a 6-digit code with a 5-minute TTL, verifies it within 5 minutes, and invalidates it after single use", async () => {
    const d1 = createSqliteD1();
    const nowMs = 1_760_000_000_000;

    const challenge = await issueEmailOtpChallenge(d1, {
      email: "Ada@Mortem.dev",
      mode: "sign-up",
      nowMs,
    });

    expect(challenge.email).toBe("ada@mortem.dev");
    expect(challenge.code).toMatch(/^\d{6}$/);
    expect(challenge.expiresAt).toBe(nowMs + EMAIL_OTP_TTL_MS);
    expect(challenge.ttlSeconds).toBe(300);

    // Verify at 4m 59s -> succeeds
    const verified = await verifyEmailOtpChallenge(d1, {
      email: "ada@mortem.dev",
      mode: "sign-up",
      code: challenge.code,
      nowMs: nowMs + 299_000,
    });
    expect(verified).toEqual({
      verified: true,
      email: "ada@mortem.dev",
      mode: "sign-up",
    });

    // Reusing the same code a second time fails with otp_not_found
    await expect(
      verifyEmailOtpChallenge(d1, {
        email: "ada@mortem.dev",
        mode: "sign-up",
        code: challenge.code,
        nowMs: nowMs + 299_500,
      }),
    ).rejects.toMatchObject({
      code: "otp_not_found",
      httpStatus: 404,
    });
  });

  it("invalidates codes after 5 minutes (300,000 ms) and allows resending a fresh code that invalidates prior codes", async () => {
    const d1 = createSqliteD1();
    const t0 = 1_760_000_000_000;

    const first = await issueEmailOtpChallenge(d1, {
      email: "grace@mortem.dev",
      mode: "sign-in",
      codeOverride: "111222",
      nowMs: t0,
    });

    // At 5 minutes + 1 ms -> rejected as expired (410) and purged from D1
    await expect(
      verifyEmailOtpChallenge(d1, {
        email: "grace@mortem.dev",
        mode: "sign-in",
        code: first.code,
        nowMs: t0 + EMAIL_OTP_TTL_MS + 1,
      }),
    ).rejects.toMatchObject({
      code: "otp_expired",
      httpStatus: 410,
    });

    // Issue a code, then immediately resend a new code -> old code is invalidated
    await issueEmailOtpChallenge(d1, {
      email: "grace@mortem.dev",
      mode: "sign-in",
      codeOverride: "333444",
      nowMs: t0 + 10_000,
    });

    const resent = await issueEmailOtpChallenge(d1, {
      email: "grace@mortem.dev",
      mode: "sign-in",
      codeOverride: "555666",
      nowMs: t0 + 20_000,
    });

    await expect(
      verifyEmailOtpChallenge(d1, {
        email: "grace@mortem.dev",
        mode: "sign-in",
        code: "333444",
        nowMs: t0 + 25_000,
      }),
    ).rejects.toMatchObject({
      code: "otp_invalid",
      httpStatus: 422,
    });

    const verifiedResent = await verifyEmailOtpChallenge(d1, {
      email: "grace@mortem.dev",
      mode: "sign-in",
      code: resent.code,
      nowMs: t0 + 25_000,
    });
    expect(verifiedResent.verified).toBe(true);
  });

  it("invalidates the OTP code after 5 consecutive wrong attempts", async () => {
    const d1 = createSqliteD1();
    const t0 = 1_760_000_000_000;

    await issueEmailOtpChallenge(d1, {
      email: "alan@mortem.dev",
      mode: "sign-in",
      codeOverride: "987654",
      nowMs: t0,
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        verifyEmailOtpChallenge(d1, {
          email: "alan@mortem.dev",
          mode: "sign-in",
          code: "000000",
          nowMs: t0 + attempt * 1_000,
        }),
      ).rejects.toMatchObject({
        code: "otp_invalid",
        httpStatus: 422,
      });
    }

    // 5th wrong attempt invalidates and deletes the code
    await expect(
      verifyEmailOtpChallenge(d1, {
        email: "alan@mortem.dev",
        mode: "sign-in",
        code: "000000",
        nowMs: t0 + 5_000,
      }),
    ).rejects.toMatchObject({
      code: "otp_max_attempts",
      httpStatus: 429,
    });

    // Even the correct code is now rejected because the challenge was invalidated
    await expect(
      verifyEmailOtpChallenge(d1, {
        email: "alan@mortem.dev",
        mode: "sign-in",
        code: "987654",
        nowMs: t0 + 6_000,
      }),
    ).rejects.toBeInstanceOf(EmailOtpError);
  });

  it("delivers 5-minute OTP emails via Resend HTTP API", async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "re_msg_123" }), { status: 200 }),
    );

    const result = await sendOtpEmailViaResend({
      apiKey: "re_test_key",
      fromEmail: "mortem@corstack.dev",
      toEmail: "founder@acme.io",
      code: "482910",
      mode: "sign-up",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.id).toBe("re_msg_123");
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

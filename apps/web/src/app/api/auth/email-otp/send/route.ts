import {
  EmailOtpError,
  PlatformBindingError,
  defaultCloudflareTurnstileVerifier,
  issueEmailOtpChallenge,
  sendOtpEmailViaResend,
  type D1DatabaseLike,
  type EmailOtpMode,
  type MortemWebBindings,
  type TurnstileVerifierFn,
} from "@mortem/core";
import { NextResponse } from "next/server";
import { createMortemAuth, getRequestAuth } from "@/lib/auth";

export interface EmailOtpSendTestOverrides {
  turnstileVerifier?: TurnstileVerifierFn;
  onOtpIssued?: (notice: {
    email: string;
    mode: EmailOtpMode;
    code: string;
    expiresAt: number;
  }) => void | Promise<void>;
  now?: () => number;
}

let testOverrides: EmailOtpSendTestOverrides = {};

export function setEmailOtpSendTestOverrides(
  overrides: EmailOtpSendTestOverrides,
): void {
  testOverrides = overrides;
}

interface SendOtpRequestBody {
  mode?: EmailOtpMode;
  name?: string;
  email?: string;
  password?: string;
  turnstileToken?: string;
  isResend?: boolean;
}

export async function handleSendEmailOtp(
  request: Request,
  injected?: {
    d1: D1DatabaseLike;
    env?: Partial<MortemWebBindings>;
    overrides?: EmailOtpSendTestOverrides;
  },
): Promise<Response> {
  try {
    const resolved = injected
      ? {
          d1: injected.d1,
          env: injected.env ?? { ENVIRONMENT: "test" },
          auth: createMortemAuth({
            d1: injected.d1,
            env: injected.env,
            requestOrigin: new URL(request.url).origin,
          }),
        }
      : await getRequestAuth(request);
    const { auth, d1, env } = resolved;
    const activeOverrides = injected?.overrides ?? testOverrides;
    const body = (await request
      .json()
      .catch(() => null)) as SendOtpRequestBody | null;

    const mode: EmailOtpMode = body?.mode === "sign-up" ? "sign-up" : "sign-in";
    const email = (body?.email ?? "").trim().toLowerCase();
    const name = (body?.name ?? "").trim();
    const password = body?.password ?? "";
    const turnstileToken = (body?.turnstileToken ?? "").trim();
    const isResend = body?.isResend === true;

    if (!email || !email.includes("@")) {
      return NextResponse.json(
        {
          ok: false,
          code: "invalid_input",
          error: "Enter a valid email address.",
        },
        { status: 422 },
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        {
          ok: false,
          code: "invalid_input",
          error: "Password must be at least 8 characters.",
        },
        { status: 422 },
      );
    }

    if (mode === "sign-up" && !name) {
      return NextResponse.json(
        {
          ok: false,
          code: "invalid_input",
          error: "Enter your full name to create a workspace.",
        },
        { status: 422 },
      );
    }

    // 1. Verify Cloudflare Turnstile challenge unless this is an in-flow code resend
    const isTestEnv = env.ENVIRONMENT === "test";
    const isProductionEnv = env.ENVIRONMENT === "production";
    const isNonProdE2eEmail =
      !isProductionEnv && email.endsWith("@mortem.test");
    const turnstileSecret = (
      env.TURNSTILE_SECRET_KEY ??
      (isTestEnv ? "" : process.env.TURNSTILE_SECRET_KEY) ??
      ""
    ).trim();

    if (!isResend && turnstileSecret) {
      if (!turnstileToken) {
        return NextResponse.json(
          {
            ok: false,
            code: "turnstile_failed",
            error:
              "Complete the Cloudflare Turnstile security check to continue.",
          },
          { status: 403 },
        );
      }

      const isAllowedE2eToken =
        isNonProdE2eEmail &&
        !activeOverrides.turnstileVerifier &&
        turnstileToken === "e2e-turnstile-pass-token";

      if (!isAllowedE2eToken) {
        const verifier =
          activeOverrides.turnstileVerifier ??
          defaultCloudflareTurnstileVerifier;
        const clientIp =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

        const valid = await verifier(turnstileToken, turnstileSecret, clientIp);
        if (!valid) {
          return NextResponse.json(
            {
              ok: false,
              code: "turnstile_failed",
              error:
                "Cloudflare Turnstile verification failed or expired. Please complete the challenge again.",
            },
            { status: 403 },
          );
        }
      }
    }

    // 2. Validate account state / credentials BEFORE sending an email OTP
    if (mode === "sign-up") {
      const existingUser = await d1
        .prepare(`SELECT id FROM users WHERE lower(email) = ? LIMIT 1`)
        .bind(email)
        .first<{ id: string }>();

      if (existingUser) {
        return NextResponse.json(
          {
            ok: false,
            code: "email_already_registered",
            error:
              "An account with this email already exists. Please sign in instead.",
          },
          { status: 409 },
        );
      }
    } else {
      // Pre-verify sign-in email & password via Better Auth and immediately revoke the pre-check session
      const origin = new URL(request.url).origin;
      const precheckReq = new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
        },
        body: JSON.stringify({ email, password }),
      });

      const precheckRes = await auth.handler(precheckReq);
      if (!precheckRes.ok) {
        return NextResponse.json(
          {
            ok: false,
            code: "invalid_credentials",
            error: "Invalid email or password.",
          },
          { status: 401 },
        );
      }

      const precheckData = (await precheckRes.json().catch(() => null)) as {
        token?: string;
        user?: { id?: string };
      } | null;

      if (precheckData?.token) {
        await d1
          .prepare(`DELETE FROM sessions WHERE token = ?`)
          .bind(precheckData.token)
          .run();
      } else if (precheckData?.user?.id) {
        await d1
          .prepare(
            `DELETE FROM sessions
             WHERE id IN (
               SELECT id FROM sessions
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT 1
             )`,
          )
          .bind(precheckData.user.id)
          .run();
      }
    }

    // 3. Issue 5-minute OTP challenge in D1 verifications (invalidating any previous code)
    const nowMs = activeOverrides.now ? activeOverrides.now() : Date.now();
    const challenge = await issueEmailOtpChallenge(d1, {
      email,
      mode,
      nowMs,
    });

    if (activeOverrides.onOtpIssued) {
      await activeOverrides.onOtpIssued({
        email: challenge.email,
        mode: challenge.mode,
        code: challenge.code,
        expiresAt: challenge.expiresAt,
      });
    }

    const resendApiKey = (
      env.RESEND_API_KEY ??
      (isTestEnv ? "" : process.env.RESEND_API_KEY) ??
      ""
    ).trim();
    const emailFrom = (
      env.MORTEM_EMAIL_FROM ??
      process.env.MORTEM_EMAIL_FROM ??
      "mortem@corstack.dev"
    ).trim();

    if (resendApiKey && !activeOverrides.onOtpIssued && !isNonProdE2eEmail) {
      await sendOtpEmailViaResend({
        apiKey: resendApiKey,
        fromEmail: emailFrom,
        toEmail: challenge.email,
        code: challenge.code,
        mode: challenge.mode,
      });
    }

    return NextResponse.json({
      ok: true,
      email: challenge.email,
      mode: challenge.mode,
      expiresAt: challenge.expiresAt,
      ttlSeconds: challenge.ttlSeconds,
      ...(isNonProdE2eEmail ? { devTestOtpCode: challenge.code } : {}),
    });
  } catch (error) {
    if (error instanceof EmailOtpError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: error.httpStatus },
      );
    }
    if (error instanceof PlatformBindingError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          binding: error.bindingName,
          error: error.message,
        },
        { status: 503 },
      );
    }
    const message =
      error instanceof Error
        ? error.message
        : "Unable to send verification code.";
    return NextResponse.json(
      { ok: false, code: "AUTH_OTP_SEND_ERROR", error: message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleSendEmailOtp(request);
}

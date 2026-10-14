import {
  EmailOtpError,
  PlatformBindingError,
  verifyEmailOtpChallenge,
  type D1DatabaseLike,
  type EmailOtpMode,
  type MortemWebBindings,
} from "@mortem/core";
import { NextResponse } from "next/server";
import { createMortemAuth, getRequestAuth } from "@/lib/auth";

export interface EmailOtpVerifyTestOverrides {
  now?: () => number;
}

let verifyTestOverrides: EmailOtpVerifyTestOverrides = {};

export function setEmailOtpVerifyTestOverrides(
  overrides: EmailOtpVerifyTestOverrides,
): void {
  verifyTestOverrides = overrides;
}

interface VerifyOtpRequestBody {
  mode?: EmailOtpMode;
  name?: string;
  email?: string;
  password?: string;
  code?: string;
}

export async function handleVerifyEmailOtp(
  request: Request,
  injected?: {
    d1: D1DatabaseLike;
    env?: Partial<MortemWebBindings>;
    overrides?: EmailOtpVerifyTestOverrides;
  },
): Promise<Response> {
  try {
    const resolved = injected
      ? {
          d1: injected.d1,
          auth: createMortemAuth({
            d1: injected.d1,
            env: injected.env,
            requestOrigin: new URL(request.url).origin,
          }),
        }
      : await getRequestAuth(request);
    const { auth, d1 } = resolved;
    const activeOverrides = injected?.overrides ?? verifyTestOverrides;
    const body = (await request
      .json()
      .catch(() => null)) as VerifyOtpRequestBody | null;

    const mode: EmailOtpMode = body?.mode === "sign-up" ? "sign-up" : "sign-in";
    const email = (body?.email ?? "").trim().toLowerCase();
    const name = (body?.name ?? "").trim();
    const password = body?.password ?? "";
    const code = (body?.code ?? "").trim();

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

    const nowMs = activeOverrides.now ? activeOverrides.now() : Date.now();

    // 1. Verify and consume the 5-minute OTP code in D1 verifications
    await verifyEmailOtpChallenge(d1, {
      email,
      mode,
      code,
      nowMs,
    });

    // 2. Complete the Better Auth sign-up or sign-in flow and issue the session cookie
    const origin = new URL(request.url).origin;
    const authEndpoint =
      mode === "sign-up"
        ? `${origin}/api/auth/sign-up/email`
        : `${origin}/api/auth/sign-in/email`;

    const forwardHeaders = new Headers({
      "content-type": "application/json",
      origin,
    });
    const userAgent = request.headers.get("user-agent");
    if (userAgent) {
      forwardHeaders.set("user-agent", userAgent);
    }
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp) {
      forwardHeaders.set("cf-connecting-ip", clientIp);
    }

    const authReq = new Request(authEndpoint, {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify(
        mode === "sign-up" ? { name, email, password } : { email, password },
      ),
    });

    const authRes = await auth.handler(authReq);
    if (!authRes.ok) {
      const errData = (await authRes.json().catch(() => null)) as {
        message?: string;
        error?: string;
      } | null;
      return NextResponse.json(
        {
          ok: false,
          code: "invalid_credentials",
          error:
            errData?.message ??
            errData?.error ??
            (mode === "sign-up"
              ? "Unable to create account."
              : "Invalid email or password."),
        },
        { status: authRes.status || 401 },
      );
    }

    // 3. Mark user email_verified = 1 in D1
    await d1
      .prepare(
        `UPDATE users
         SET email_verified = 1, updated_at = ?
         WHERE lower(email) = ?`,
      )
      .bind(nowMs, email)
      .run();

    const authPayload = (await authRes.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    const responseHeaders = new Headers();
    const getSetCookie = (
      authRes.headers as unknown as { getSetCookie?: () => string[] }
    ).getSetCookie;
    if (typeof getSetCookie === "function") {
      for (const cookie of getSetCookie.call(authRes.headers)) {
        responseHeaders.append("set-cookie", cookie);
      }
    } else {
      const rawCookie = authRes.headers.get("set-cookie");
      if (rawCookie) {
        responseHeaders.set("set-cookie", rawCookie);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        verified: true,
        mode,
        ...authPayload,
      },
      {
        status: 200,
        headers: responseHeaders,
      },
    );
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
        : "Unable to verify confirmation code.";
    return NextResponse.json(
      { ok: false, code: "AUTH_OTP_VERIFY_ERROR", error: message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleVerifyEmailOtp(request);
}

import { PlatformBindingError } from "@mortem/core";
import { NextResponse } from "next/server";
import { getRequestAuth } from "@/lib/auth";

async function handleAuthRequest(request: Request): Promise<Response> {
  try {
    const { auth, env } = await getRequestAuth(request);
    const pathname = new URL(request.url).pathname;
    const isTestEnv = env.ENVIRONMENT === "test";
    const turnstileSecret = (
      env.TURNSTILE_SECRET_KEY ??
      (isTestEnv ? "" : process.env.TURNSTILE_SECRET_KEY) ??
      ""
    ).trim();

    if (
      request.method.toUpperCase() === "POST" &&
      turnstileSecret &&
      (pathname.endsWith("/sign-in/email") ||
        pathname.endsWith("/sign-up/email"))
    ) {
      return NextResponse.json(
        {
          ok: false,
          code: "otp_required",
          error:
            "Cloudflare Turnstile verification and a 5-minute email confirmation code are required.",
        },
        { status: 403 },
      );
    }

    return await auth.handler(request);
  } catch (error) {
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
      error instanceof Error ? error.message : "Authentication handler failed.";
    return NextResponse.json(
      { ok: false, code: "AUTH_ERROR", error: message },
      { status: 500 },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleAuthRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleAuthRequest(request);
}

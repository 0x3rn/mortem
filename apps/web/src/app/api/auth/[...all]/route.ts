import { PlatformBindingError } from "@mortem/core";
import { NextResponse } from "next/server";
import { getRequestAuth } from "@/lib/auth";

async function handleAuthRequest(request: Request): Promise<Response> {
  try {
    const { auth } = await getRequestAuth(request);
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

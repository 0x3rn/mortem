"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          theme?: "light" | "dark" | "auto";
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

export interface AuthCardProps {
  mode: "sign-in" | "sign-up";
  turnstileSiteKey?: string;
}

const DEFAULT_TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "0x4AAAAAAFSFBv33VMh4DpXy";

function resolveSafeRedirectTarget(): string {
  if (typeof window === "undefined") {
    return "/workspace";
  }
  const nextParam = new URLSearchParams(window.location.search).get("next");
  if (
    nextParam &&
    nextParam.startsWith("/") &&
    !nextParam.startsWith("//") &&
    !nextParam.startsWith("/sign-in") &&
    !nextParam.startsWith("/sign-up")
  ) {
    return nextParam;
  }
  return "/workspace";
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function AuthCard({ mode, turnstileSiteKey }: AuthCardProps) {
  const router = useRouter();
  const effectiveSiteKey = (
    turnstileSiteKey ??
    DEFAULT_TURNSTILE_SITE_KEY ??
    ""
  ).trim();

  const [step, setStep] = useState<"credentials" | "verify-otp">("credentials");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [otpExpiresAt, setOtpExpiresAt] = useState<number | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(300);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function redirectIfAuthenticated() {
      try {
        const response = await fetch("/api/workspaces", {
          credentials: "include",
          cache: "no-store",
        });
        if (!cancelled && response.ok) {
          router.replace(resolveSafeRedirectTarget());
        }
      } catch {
        // Ignore network errors during background session check
      }
    }
    void redirectIfAuthenticated();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Render Cloudflare Turnstile widget when on the credentials step
  useEffect(() => {
    if (step !== "credentials" || !effectiveSiteKey) {
      return;
    }

    let cancelled = false;

    function mountTurnstile() {
      if (
        cancelled ||
        !turnstileContainerRef.current ||
        !window.turnstile ||
        turnstileWidgetIdRef.current !== null
      ) {
        return;
      }

      turnstileContainerRef.current.innerHTML = "";
      const widgetId = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: effectiveSiteKey,
        theme: "dark",
        callback: (token: string) => {
          if (!cancelled) {
            setTurnstileToken(token);
            setErrorMessage(null);
          }
        },
        "expired-callback": () => {
          if (!cancelled) {
            setTurnstileToken("");
          }
        },
        "error-callback": () => {
          if (!cancelled) {
            setTurnstileToken("");
          }
        },
      });
      turnstileWidgetIdRef.current = widgetId;
    }

    if (window.turnstile) {
      mountTurnstile();
    } else {
      const existingScript = document.querySelector<HTMLScriptElement>(
        'script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]',
      );
      if (existingScript) {
        existingScript.addEventListener("load", mountTurnstile);
      } else {
        const script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.addEventListener("load", mountTurnstile);
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (turnstileWidgetIdRef.current && window.turnstile?.remove) {
        try {
          window.turnstile.remove(turnstileWidgetIdRef.current);
        } catch {
          // Ignore cleanup errors
        }
      }
      turnstileWidgetIdRef.current = null;
    };
  }, [step, effectiveSiteKey]);

  // 5-minute OTP countdown timer
  useEffect(() => {
    if (step !== "verify-otp" || !otpExpiresAt) {
      return;
    }

    function updateCountdown() {
      const remaining = Math.max(
        0,
        Math.ceil((otpExpiresAt! - Date.now()) / 1000),
      );
      setSecondsRemaining(remaining);
    }

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [step, otpExpiresAt]);

  function resetTurnstileWidget() {
    setTurnstileToken("");
    if (turnstileWidgetIdRef.current && window.turnstile?.reset) {
      try {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      } catch {
        // Ignore reset errors
      }
    }
  }

  async function handleCredentialsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();

    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setErrorMessage("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setErrorMessage("Password must be at least 8 characters.");
      return;
    }
    if (mode === "sign-up" && !trimmedName) {
      setErrorMessage("Enter your full name to create a workspace.");
      return;
    }
    if (!turnstileToken) {
      setErrorMessage(
        "Complete the Cloudflare Turnstile security check before continuing.",
      );
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/email-otp/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          mode,
          name: mode === "sign-up" ? trimmedName : undefined,
          email: trimmedEmail,
          password,
          turnstileToken,
        }),
      });

      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        expiresAt?: number;
        ttlSeconds?: number;
        message?: string;
        error?: string;
      } | null;

      if (!response.ok || !data?.ok) {
        resetTurnstileWidget();
        setErrorMessage(
          data?.error ??
            data?.message ??
            (mode === "sign-up"
              ? "Unable to start account verification. Check your details and try again."
              : "Invalid email or password."),
        );
        return;
      }

      const expiresAt =
        typeof data.expiresAt === "number"
          ? data.expiresAt
          : Date.now() + 5 * 60 * 1000;
      setOtpExpiresAt(expiresAt);
      setSecondsRemaining(
        Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
      );
      setOtpCode("");
      setStep("verify-otp");
      setStatusMessage(
        `We sent a 6-digit confirmation code to ${trimmedEmail}. It expires in 5 minutes.`,
      );
    } catch {
      resetTurnstileWidget();
      setErrorMessage("Network error while communicating with Mortem Auth.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyOtpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);

    const normalizedCode = otpCode.trim();
    if (!/^\d{6}$/.test(normalizedCode)) {
      setErrorMessage("Enter the 6-digit verification code from your email.");
      return;
    }

    if (secondsRemaining <= 0) {
      setErrorMessage(
        "This verification code has expired after 5 minutes. Click 'Resend new code' below.",
      );
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/email-otp/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          mode,
          name: mode === "sign-up" ? name.trim() : undefined,
          email: email.trim().toLowerCase(),
          password,
          code: normalizedCode,
        }),
      });

      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        code?: string;
        error?: string;
        message?: string;
      } | null;

      if (!response.ok || !data?.ok) {
        if (data?.code === "otp_expired") {
          setSecondsRemaining(0);
        }
        setErrorMessage(
          data?.error ??
            data?.message ??
            "Invalid or expired verification code.",
        );
        return;
      }

      const target = resolveSafeRedirectTarget();
      router.push(target);
      router.refresh();
    } catch {
      setErrorMessage("Network error while verifying confirmation code.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendOtp() {
    setErrorMessage(null);
    setStatusMessage(null);
    setResending(true);

    try {
      const trimmedEmail = email.trim().toLowerCase();
      const response = await fetch("/api/auth/email-otp/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          mode,
          name: mode === "sign-up" ? name.trim() : undefined,
          email: trimmedEmail,
          password,
          isResend: true,
        }),
      });

      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        expiresAt?: number;
        error?: string;
      } | null;

      if (!response.ok || !data?.ok) {
        setErrorMessage(
          data?.error ?? "Unable to resend verification code right now.",
        );
        return;
      }

      const expiresAt =
        typeof data.expiresAt === "number"
          ? data.expiresAt
          : Date.now() + 5 * 60 * 1000;
      setOtpExpiresAt(expiresAt);
      setSecondsRemaining(300);
      setOtpCode("");
      setStatusMessage(
        `Sent a new 6-digit code to ${trimmedEmail} (valid for 5 minutes). Any previous code is now invalid.`,
      );
    } catch {
      setErrorMessage("Network error while resending verification code.");
    } finally {
      setResending(false);
    }
  }

  async function handleGoogleSignIn() {
    setErrorMessage(null);
    setStatusMessage(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/workspace",
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        url?: string;
        message?: string;
        error?: string;
      } | null;
      if (response.ok && data?.url) {
        window.location.assign(data.url);
        return;
      }
      setErrorMessage(
        data?.message ??
          data?.error ??
          "Google OAuth is not configured in this environment.",
      );
    } catch {
      setErrorMessage("Unable to initiate Google OAuth sign-in.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasswordResetRequest() {
    setErrorMessage(null);
    setStatusMessage(null);
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setErrorMessage(
        "Enter your account email above first to request a password reset link.",
      );
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          redirectTo: "/sign-in",
        }),
      });
      if (response.ok) {
        setStatusMessage(
          `If an account exists for ${trimmedEmail}, a password reset link has been issued.`,
        );
      } else {
        setErrorMessage("Unable to process password reset request right now.");
      }
    } catch {
      setErrorMessage("Unable to process password reset request right now.");
    } finally {
      setSubmitting(false);
    }
  }

  const isCredentialsButtonDisabled = submitting || !turnstileToken;
  const isVerifyButtonDisabled =
    submitting ||
    resending ||
    secondsRemaining <= 0 ||
    otpCode.trim().length !== 6;

  return (
    <div className="mx-auto w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm sm:p-8">
      <div className="mb-6">
        <p className="font-mono text-xs font-semibold tracking-wider text-primary uppercase">
          {step === "verify-otp"
            ? "Email Confirmation (5m TTL)"
            : mode === "sign-up"
              ? "Workspace Provisioning"
              : "Workspace Access"}
        </p>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-foreground">
          {step === "verify-otp"
            ? "Enter your 6-digit verification code"
            : mode === "sign-up"
              ? "Create your Mortem workspace"
              : "Sign in to Mortem"}
        </h1>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {step === "verify-otp"
            ? `Enter the 6-digit code sent to ${email.trim().toLowerCase()}. Codes expire after 5 minutes.`
            : mode === "sign-up"
              ? "Every scan, autopsy report, and finding is isolated inside your personal workspace."
              : "Access your saved website autopsies, score history, and workspace settings."}
        </p>
      </div>

      {step === "credentials" ? (
        <form
          onSubmit={handleCredentialsSubmit}
          className="space-y-4"
          noValidate
        >
          {mode === "sign-up" ? (
            <div>
              <label
                htmlFor="auth-name"
                className="block text-xs font-medium text-foreground"
              >
                Full name
              </label>
              <input
                id="auth-name"
                name="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ada Lovelace"
                className="mt-1.5 w-full rounded-md border border-border bg-background px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/30 focus:outline-none"
              />
            </div>
          ) : null}

          <div>
            <label
              htmlFor="auth-email"
              className="block text-xs font-medium text-foreground"
            >
              Work email
            </label>
            <input
              id="auth-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ada@acme-cloud.io"
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/30 focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor="auth-password"
                className="block text-xs font-medium text-foreground"
              >
                Password
              </label>
              {mode === "sign-in" ? (
                <button
                  type="button"
                  onClick={handlePasswordResetRequest}
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Forgot password?
                </button>
              ) : null}
            </div>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={
                mode === "sign-up" ? "new-password" : "current-password"
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Minimum 8 characters"
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/30 focus:outline-none"
            />
          </div>

          <div className="rounded-md border border-border bg-background/50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[11px] font-medium text-muted-foreground uppercase">
                Security Check
              </span>
              <span
                data-testid="turnstile-status"
                className={`font-mono text-[11px] font-semibold ${
                  turnstileToken ? "text-emerald-400" : "text-muted-foreground"
                }`}
              >
                {turnstileToken ? "Verified ✓" : "Required"}
              </span>
            </div>
            <div
              ref={turnstileContainerRef}
              data-testid="turnstile-widget-container"
              className="min-h-[65px] overflow-x-auto"
            />
            {!turnstileToken ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Complete the Cloudflare Turnstile verification above to unlock{" "}
                {mode === "sign-up" ? "sign up" : "sign in"}.
              </p>
            ) : null}
          </div>

          {errorMessage ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {errorMessage}
            </p>
          ) : null}

          {statusMessage ? (
            <p
              role="status"
              className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground"
            >
              {statusMessage}
            </p>
          ) : null}

          <button
            type="submit"
            data-testid="auth-credentials-submit-button"
            disabled={isCredentialsButtonDisabled}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-destructive disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-50"
          >
            {submitting
              ? "Sending confirmation code..."
              : mode === "sign-up"
                ? "Create workspace & account"
                : "Sign in to workspace"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerifyOtpSubmit} className="space-y-4" noValidate>
          <div className="flex items-center justify-between rounded-md border border-border bg-background/60 px-3.5 py-2.5">
            <span className="text-xs font-medium text-muted-foreground">
              Code expiration
            </span>
            <span
              data-testid="auth-otp-countdown"
              className={`font-mono text-xs font-semibold ${
                secondsRemaining > 0 ? "text-foreground" : "text-destructive"
              }`}
            >
              {secondsRemaining > 0
                ? `Expires in ${formatCountdown(secondsRemaining)}`
                : "Expired (5:00 elapsed)"}
            </span>
          </div>

          <div>
            <label
              htmlFor="auth-otp-code"
              className="block text-xs font-medium text-foreground"
            >
              6-digit confirmation code
            </label>
            <input
              id="auth-otp-code"
              data-testid="auth-otp-code-input"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otpCode}
              onChange={(event) =>
                setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="123456"
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3.5 py-2.5 text-center font-mono text-lg tracking-[0.35em] text-foreground placeholder:tracking-normal placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/30 focus:outline-none"
            />
          </div>

          {errorMessage ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {errorMessage}
            </p>
          ) : null}

          {statusMessage ? (
            <p
              role="status"
              className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground"
            >
              {statusMessage}
            </p>
          ) : null}

          <button
            type="submit"
            data-testid="auth-otp-verify-button"
            disabled={isVerifyButtonDisabled}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-destructive disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-50"
          >
            {submitting
              ? "Verifying code..."
              : mode === "sign-up"
                ? "Confirm email & create workspace"
                : "Confirm code & sign in"}
          </button>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => {
                setStep("credentials");
                setErrorMessage(null);
                setStatusMessage(null);
                setOtpCode("");
                resetTurnstileWidget();
              }}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              ← Edit email or password
            </button>
            <button
              type="button"
              data-testid="auth-otp-resend-button"
              onClick={handleResendOtp}
              disabled={resending || submitting}
              className="text-xs font-semibold text-primary transition-colors hover:underline disabled:opacity-50"
            >
              {resending ? "Sending new code..." : "Resend new code (5m)"}
            </button>
          </div>
        </form>
      )}

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="font-mono text-[11px] text-muted-foreground uppercase">
          or
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={submitting}
        className="w-full rounded-md border border-border bg-background/60 px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
      >
        Continue with Google
      </button>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        {mode === "sign-up" ? (
          <>
            Already have a workspace?{" "}
            <Link
              href="/sign-in"
              className="font-semibold text-foreground underline underline-offset-4 hover:text-primary"
            >
              Sign in
            </Link>
          </>
        ) : (
          <>
            Need a Mortem workspace?{" "}
            <Link
              href="/sign-up"
              className="font-semibold text-foreground underline underline-offset-4 hover:text-primary"
            >
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

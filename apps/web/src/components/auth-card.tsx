"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

export interface AuthCardProps {
  mode: "sign-in" | "sign-up";
}

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

export function AuthCard({ mode }: AuthCardProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
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

    setSubmitting(true);
    try {
      const endpoint =
        mode === "sign-up"
          ? "/api/auth/sign-up/email"
          : "/api/auth/sign-in/email";
      const payload =
        mode === "sign-up"
          ? { name: trimmedName, email: trimmedEmail, password }
          : { email: trimmedEmail, password };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => null)) as {
        message?: string;
        error?: string;
      } | null;

      if (!response.ok) {
        setErrorMessage(
          data?.message ??
            data?.error ??
            (mode === "sign-up"
              ? "Unable to create account. Check your details and try again."
              : "Invalid email or password."),
        );
        return;
      }

      const target = resolveSafeRedirectTarget();
      router.push(target);
      router.refresh();
    } catch {
      setErrorMessage("Network error while communicating with Mortem Auth.");
    } finally {
      setSubmitting(false);
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

  return (
    <div className="mx-auto w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm sm:p-8">
      <div className="mb-6">
        <p className="font-mono text-xs font-semibold tracking-wider text-primary uppercase">
          {mode === "sign-up" ? "Workspace Provisioning" : "Workspace Access"}
        </p>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-foreground">
          {mode === "sign-up"
            ? "Create your Mortem workspace"
            : "Sign in to Mortem"}
        </h1>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {mode === "sign-up"
            ? "Every scan, autopsy report, and finding is isolated inside your personal workspace."
            : "Access your saved website autopsies, score history, and workspace settings."}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
          disabled={submitting}
          className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-destructive disabled:opacity-50"
        >
          {submitting
            ? "Authenticating..."
            : mode === "sign-up"
              ? "Create workspace & account"
              : "Sign in to workspace"}
        </button>
      </form>

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

"use client";

import { useState } from "react";

interface ExamineFormProps {
  id?: string;
  buttonLabel?: string;
}

function normalizeUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname || !parsed.hostname.includes(".")) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function ExamineForm({
  id,
  buttonLabel = "Run autopsy",
}: ExamineFormProps) {
  const [value, setValue] = useState("");
  const [submittedUrl, setSubmittedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalized = normalizeUrlInput(value);
    if (!normalized) {
      setSubmittedUrl(null);
      setError("Enter a valid domain or URL (for example, stripe.com).");
      return;
    }
    setError(null);
    setSubmittedUrl(normalized);
  }

  return (
    <div id={id} className="mx-auto w-full max-w-xl">
      <form
        className="flex flex-col gap-2.5 sm:flex-row"
        onSubmit={handleSubmit}
        noValidate
      >
        <label htmlFor={id ? `${id}-input` : "examine-url-input"} className="sr-only">
          Website URL to examine
        </label>
        <input
          id={id ? `${id}-input` : "examine-url-input"}
          type="text"
          inputMode="url"
          autoComplete="url"
          required
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="yourwebsite.com or https://yourwebsite.com/pricing"
          className="flex-1 rounded-md border border-input bg-card px-4 py-3.5 text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:outline-none"
        />
        <button
          type="submit"
          className="cursor-pointer rounded-md bg-primary px-6 py-3.5 text-sm font-semibold whitespace-nowrap text-primary-foreground transition-colors hover:bg-destructive"
        >
          {buttonLabel}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2.5 text-left text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {submittedUrl ? (
        <div
          role="status"
          className="mt-3 rounded-md border border-border bg-card/80 px-4 py-3 text-left text-xs text-muted-foreground"
        >
          <span className="font-semibold text-foreground">Target normalized:</span>{" "}
          <code className="text-foreground">{submittedUrl}</code> — Intake pipeline (
          <code className="text-foreground">POST /api/scans</code>) is being wired in
          Milestone 01.
        </div>
      ) : null}
    </div>
  );
}


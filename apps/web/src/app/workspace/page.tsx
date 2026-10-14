import Link from "next/link";
import { WorkspaceShell } from "./workspace-shell";

export default function WorkspacePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80 bg-background/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-full bg-primary"
            />
            <span className="font-display text-lg font-bold tracking-tight">
              Mortem
            </span>
            <span className="hidden rounded border border-border bg-card px-2 py-0.5 font-mono text-xs text-muted-foreground sm:inline-block">
              Workspace Console
            </span>
          </Link>
          <Link
            href="/"
            className="text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            ← Back to Examine URL
          </Link>
        </div>
      </header>

      <main>
        <WorkspaceShell />
      </main>
    </div>
  );
}

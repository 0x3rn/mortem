import Link from "next/link";
import { AuthCard } from "@/components/auth-card";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen flex-col justify-between bg-background text-foreground">
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
          </Link>
          <Link
            href="/sign-in"
            className="text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign in →
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center px-4 py-12 sm:px-6">
        <AuthCard mode="sign-up" />
      </main>
    </div>
  );
}

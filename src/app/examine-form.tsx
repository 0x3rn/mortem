"use client";

export function ExamineForm() {
  return (
    <form
      className="mx-auto mt-8 flex max-w-md gap-2"
      onSubmit={(e) => e.preventDefault()}
    >
      <input
        type="url"
        required
        placeholder="https://yourwebsite.com"
        className="flex-1 rounded-md border border-input bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:outline-none"
      />
      <button
        type="submit"
        className="rounded-md bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-destructive"
      >
        Examine
      </button>
    </form>
  );
}

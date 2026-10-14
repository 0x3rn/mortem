import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function assertZeroSeriousOrCriticalAxeViolations(
  page: Page,
  contextLabel: string,
) {
  const results = await new AxeBuilder({ page }).analyze();
  const severeViolations = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    severeViolations,
    `Expected 0 serious/critical axe violations on ${contextLabel}, found: ${JSON.stringify(
      severeViolations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.map((n) => n.html),
      })),
    )}`,
  ).toEqual([]);
}

test("renders Mortem landing page and normalizes intake URL", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: /quietly killing your website's traffic and conversions/i,
    }),
  ).toBeVisible();

  const heroInput = page.locator("#hero-examine-input");
  await heroInput.fill("stripe.com/pricing");
  await page.getByRole("button", { name: "Examine website" }).click();

  await expect(page.getByRole("status")).toContainText(
    "https://stripe.com/pricing",
  );
});

test("completes sign-up, automatic workspace provisioning, sign-out, and sign-in flow", async ({
  page,
}) => {
  const uniqueEmail = `e2e-${Date.now()}@mortem.test`;
  const password = "e2e-forensic-password-99";

  // 1. Unauthenticated visit to /workspace redirects to /sign-in?next=%2Fworkspace
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fworkspace$/, {
    timeout: 15_000,
  });

  // 2. Register on /sign-up -> redirects to /workspace with provisioned personal workspace
  await page.goto("/sign-up");
  await expect(
    page.getByRole("heading", { name: /create your mortem workspace/i }),
  ).toBeVisible();

  await page.locator("#auth-name").fill("E2E Forensic Investigator");
  await page.locator("#auth-email").fill(uniqueEmail);
  await page.locator("#auth-password").fill(password);
  await page
    .getByRole("button", { name: /create workspace & account/i })
    .click();

  await expect(page).toHaveURL(/\/workspace$/, { timeout: 15_000 });
  await expect(page.getByTestId("workspace-heading")).toContainText(
    "E2E Forensic Investigator's Workspace",
  );
  await expect(page.getByTestId("workspace-user-email")).toHaveText(
    uniqueEmail,
  );

  // 3. Visiting /sign-in while already authenticated redirects back to /workspace
  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/workspace$/, { timeout: 15_000 });

  // 4. Sign out -> redirects to /sign-in
  await page.getByTestId("sign-out-button").click();
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 15_000 });

  // 5. Sign back in with the same credentials -> redirects to /workspace
  await page.locator("#auth-email").fill(uniqueEmail);
  await page.locator("#auth-password").fill(password);
  await page.getByRole("button", { name: /sign in to workspace/i }).click();

  await expect(page).toHaveURL(/\/workspace$/, { timeout: 15_000 });
  await expect(page.getByTestId("workspace-heading")).toContainText(
    "E2E Forensic Investigator's Workspace",
  );
});

test("shows honest empty state on dashboard, starts a scan, views scan detail, and passes @axe-core/playwright on desktop and mobile (THE-174)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const uniqueEmail = `e2e-dashboard-${Date.now()}@mortem.test`;
  const password = "e2e-dashboard-password-99";

  // 1. Desktop & Mobile accessibility check on public landing page
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await assertZeroSeriousOrCriticalAxeViolations(
    page,
    "Landing page (Desktop 1440x900)",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await assertZeroSeriousOrCriticalAxeViolations(
    page,
    "Landing page (Mobile 390x844)",
  );

  // 2. Sign up and navigate to /dashboard
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/sign-up?next=%2Fdashboard");
  await page.locator("#auth-name").fill("Dr. Ada Diagnostic");
  await page.locator("#auth-email").fill(uniqueEmail);
  await page.locator("#auth-password").fill(password);
  await page
    .getByRole("button", { name: /create workspace & account/i })
    .click();

  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
  await expect(page.getByTestId("dashboard-heading")).toHaveText(
    "Start a website autopsy",
  );

  // 3. New user sees an honest empty state and zero scans
  await expect(page.getByTestId("scan-history-empty")).toBeVisible();
  await expect(page.getByTestId("metric-total-scans")).toHaveText("0");
  await expect(page.getByTestId("metric-avg-score")).toHaveText("—");

  // Run axe-core on empty dashboard (desktop & mobile)
  await assertZeroSeriousOrCriticalAxeViolations(
    page,
    "Dashboard empty state (Desktop 1440x900)",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await assertZeroSeriousOrCriticalAxeViolations(
    page,
    "Dashboard empty state (Mobile 390x844)",
  );

  // 4. Start a scan from the dashboard quick-scan form
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("empty-state-start-scan-button").click();
  const dashboardInput = page.locator("#dashboard-examine-input");
  await expect(dashboardInput).toBeFocused();
  await dashboardInput.fill("example.com");
  await page.getByRole("button", { name: "Start scan" }).click();

  // 5. Verify scan appears in workspace history table and link to scan detail works
  await expect(page.getByTestId("scan-history-table")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("metric-total-scans")).toHaveText("1");
  await expect(page.getByTestId("scan-history-table")).toContainText(
    "https://example.com/",
  );

  await page.getByTestId("examine-created-scan-link").click();
  await expect(page).toHaveURL(/\/scans\/scan_/, { timeout: 15_000 });
  await expect(page.getByTestId("scan-detail-target-url")).toHaveText(
    "https://example.com/",
  );
  await expect(page.getByTestId("scan-detail-status")).toHaveText(/queued/i);
  await expect(page.getByTestId("scan-lifecycle-stepper")).toBeVisible();
  await expect(page.getByTestId("scan-events-list")).toContainText("queued");

  // 6. Run axe-core on scan detail view (desktop & mobile)
  await assertZeroSeriousOrCriticalAxeViolations(
    page,
    "Scan detail page (Desktop 1440x900)",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await assertZeroSeriousOrCriticalAxeViolations(
    page,
    "Scan detail page (Mobile 390x844)",
  );
});

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

async function installTurnstileWidgetStub(page: Page) {
  await page.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js*",
    async (route) => {
      const script = `
        window.turnstile = {
          render: function(container, options) {
            container.innerHTML = '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-testid', 'mock-turnstile-challenge');
            btn.textContent = 'Complete Cloudflare Turnstile challenge';
            btn.style.padding = '8px 12px';
            btn.style.borderRadius = '8px';
            btn.style.border = '1px solid #3f3f46';
            btn.style.background = '#18181b';
            btn.style.color = '#e4e4e7';
            btn.addEventListener('click', function() {
              btn.textContent = 'Turnstile verified';
              if (options && typeof options.callback === 'function') {
                options.callback('e2e-turnstile-pass-token');
              }
            });
            container.appendChild(btn);
            return 'mock-widget-1';
          },
          reset: function() {},
          remove: function() {}
        };
      `;
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: script,
      });
    },
  );
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

test("enforces Cloudflare Turnstile disabled button gate, 5-minute OTP confirmation, code resend invalidation, and sign-in OTP flow", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await installTurnstileWidgetStub(page);

  const uniqueEmail = `e2e-${Date.now()}@mortem.test`;
  const password = "e2e-forensic-password-99";

  // 1. Unauthenticated visit to /workspace redirects to /sign-in?next=%2Fworkspace
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fworkspace$/, {
    timeout: 15_000,
  });

  // 2. Visit /sign-up: verify submit button is disabled until Turnstile challenge is completed
  await page.goto("/sign-up");
  await expect(
    page.getByRole("heading", { name: /create your mortem workspace/i }),
  ).toBeVisible();

  await page.locator("#auth-name").fill("E2E Forensic Investigator");
  await page.locator("#auth-email").fill(uniqueEmail);
  await page.locator("#auth-password").fill(password);

  const signUpSubmitBtn = page.getByTestId("auth-credentials-submit-button");
  await expect(signUpSubmitBtn).toBeDisabled();

  // Complete the Turnstile widget challenge -> button becomes enabled
  await page.getByTestId("mock-turnstile-challenge").click();
  await expect(signUpSubmitBtn).toBeEnabled();

  // Click submit -> sends 5-minute OTP code and transitions to OTP confirmation screen
  const firstOtpResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/auth/email-otp/send") &&
      res.request().method() === "POST",
  );
  await signUpSubmitBtn.click();
  const firstOtpResponse = await firstOtpResponsePromise;
  expect(firstOtpResponse.status()).toBe(200);
  const firstOtpData = (await firstOtpResponse.json()) as {
    ok: boolean;
    ttlSeconds: number;
    devTestOtpCode: string;
  };
  expect(firstOtpData.ok).toBe(true);
  expect(firstOtpData.ttlSeconds).toBe(300);
  expect(firstOtpData.devTestOtpCode).toMatch(/^\d{6}$/);

  await expect(page.getByTestId("auth-otp-countdown")).toBeVisible();
  await expect(page.getByTestId("auth-otp-verify-button")).toBeDisabled();

  // 3. Test Resend new code (5m): invalidates previous code and issues a new 6-digit code
  const resendOtpResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/auth/email-otp/send") &&
      res.request().method() === "POST",
  );
  await page.getByTestId("auth-otp-resend-button").click();
  const resendOtpResponse = await resendOtpResponsePromise;
  expect(resendOtpResponse.status()).toBe(200);
  const resendOtpData = (await resendOtpResponse.json()) as {
    devTestOtpCode: string;
  };
  expect(resendOtpData.devTestOtpCode).toMatch(/^\d{6}$/);

  if (firstOtpData.devTestOtpCode !== resendOtpData.devTestOtpCode) {
    await page
      .getByTestId("auth-otp-code-input")
      .fill(firstOtpData.devTestOtpCode);
    await page.getByTestId("auth-otp-verify-button").click();
    await expect(page.getByText(/invalid verification code/i)).toBeVisible();
  }

  await page
    .getByTestId("auth-otp-code-input")
    .fill(resendOtpData.devTestOtpCode);
  await expect(page.getByTestId("auth-otp-verify-button")).toBeEnabled();
  await page.getByTestId("auth-otp-verify-button").click();

  await expect(page).toHaveURL(/\/workspace$/, { timeout: 15_000 });
  await expect(page.getByTestId("workspace-heading")).toContainText(
    "E2E Forensic Investigator's Workspace",
  );
  await expect(page.getByTestId("workspace-user-email")).toHaveText(
    uniqueEmail,
  );

  // 4. Visiting /sign-in while already authenticated redirects back to /workspace
  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/workspace$/, { timeout: 15_000 });

  // 5. Sign out -> redirects to /sign-in
  await page.getByTestId("sign-out-button").click();
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 15_000 });

  // 6. Sign back in: verify Sign In button is disabled until Turnstile passes, then requires 5m Email OTP
  await page.locator("#auth-email").fill(uniqueEmail);
  await page.locator("#auth-password").fill(password);

  const signInSubmitBtn = page.getByTestId("auth-credentials-submit-button");
  await expect(signInSubmitBtn).toBeDisabled();

  await page.getByTestId("mock-turnstile-challenge").click();
  await expect(signInSubmitBtn).toBeEnabled();

  const signInOtpResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/auth/email-otp/send") &&
      res.request().method() === "POST",
  );
  await signInSubmitBtn.click();
  const signInOtpResponse = await signInOtpResponsePromise;
  expect(signInOtpResponse.status()).toBe(200);
  const signInOtpData = (await signInOtpResponse.json()) as {
    devTestOtpCode: string;
  };

  await page
    .getByTestId("auth-otp-code-input")
    .fill(signInOtpData.devTestOtpCode);
  await page.getByTestId("auth-otp-verify-button").click();

  await expect(page).toHaveURL(/\/workspace$/, { timeout: 15_000 });
  await expect(page.getByTestId("workspace-heading")).toContainText(
    "E2E Forensic Investigator's Workspace",
  );
});

test("shows honest empty state on dashboard, starts a scan, views scan detail, and passes @axe-core/playwright on desktop and mobile (THE-174)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await installTurnstileWidgetStub(page);

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

  // 2. Sign up with Turnstile + 5m OTP and navigate to /dashboard
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/sign-up?next=%2Fdashboard");
  await page.locator("#auth-name").fill("Dr. Ada Diagnostic");
  await page.locator("#auth-email").fill(uniqueEmail);
  await page.locator("#auth-password").fill(password);

  await expect(
    page.getByTestId("auth-credentials-submit-button"),
  ).toBeDisabled();
  await page.getByTestId("mock-turnstile-challenge").click();
  await expect(
    page.getByTestId("auth-credentials-submit-button"),
  ).toBeEnabled();

  const otpResPromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/auth/email-otp/send") &&
      res.request().method() === "POST",
  );
  await page.getByTestId("auth-credentials-submit-button").click();
  const otpRes = await otpResPromise;
  const otpPayload = (await otpRes.json()) as { devTestOtpCode: string };

  await page.getByTestId("auth-otp-code-input").fill(otpPayload.devTestOtpCode);
  await page.getByTestId("auth-otp-verify-button").click();

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

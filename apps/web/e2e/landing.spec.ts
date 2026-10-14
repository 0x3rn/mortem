import { expect, test } from "@playwright/test";

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

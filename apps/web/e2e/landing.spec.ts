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

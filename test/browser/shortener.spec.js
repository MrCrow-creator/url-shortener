import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

test("create, copy, redirect, handle duplicates, and retain browser history", async ({
  page,
  request,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const code = `ui_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const destination = "https://example.com/browser-test?source=snip";
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("A little link goes");
  await page.getByLabel("Destination URL", { exact: true }).fill(destination);
  await page.getByLabel("Custom short code").fill(code);
  await page.getByRole("button", { name: "Shorten my link" }).click();

  const result = page.locator("#result-link");
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute("href", new RegExp(`/${code}$`));
  const shortUrl = await result.getAttribute("href");
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(page.locator("#copy-result")).toHaveText("Copied!");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shortUrl);
  const redirect = await request.get(shortUrl, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers().location).toBe(destination);
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Shorten my link" }).click();
  await expect(page.getByRole("alert")).toContainText("already in use");
  await expect(page.getByLabel("Custom short code")).toHaveAttribute("aria-invalid", "true");

  await page.reload();
  await expect(page.locator("#history-list a")).toHaveAttribute("href", shortUrl);
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.locator("#empty-history")).toBeVisible();
  const stillActive = await request.get(shortUrl, { maxRedirects: 0 });
  expect(stillActive.status()).toBe(302);
  expect(errors).toEqual([]);
});

test("mobile layout handles API failure and invalid destinations", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route("**/api/urls", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "STORAGE_UNAVAILABLE", message: "Link storage is temporarily unavailable" },
      }),
    }),
  );
  await page.goto("/");
  await page.getByLabel("Destination URL", { exact: true }).fill("https://example.com/mobile");
  await page.getByRole("button", { name: "Shorten my link" }).click();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("button", { name: "Shorten my link" })).toBeEnabled();
  await expect(page.locator("#history-list")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });

  await page.getByLabel("Destination URL", { exact: true }).fill("ftp://example.com/file");
  await page.getByRole("button", { name: "Shorten my link" }).click();
  await expect(page.getByRole("alert")).toContainText("http:// or https://");
});

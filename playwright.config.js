import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  reporter: "list",
  timeout: 30000,
  use: {
    baseURL: process.env.BROWSER_BASE_URL ?? "http://localhost:3100",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    viewport: { width: 1440, height: 1080 },
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
});

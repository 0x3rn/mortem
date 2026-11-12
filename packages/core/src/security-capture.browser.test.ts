import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectDocumentSecurity,
  type PlaywrightResponseLike,
} from "./browser-capture";
import {
  evaluateSecurityPageRules,
  parseMixedContentConsoleMessage,
} from "./security-checks";
import { findLocalChromium } from "./test-browser";

const INSECURE_HOST = "insecure.mortem.test";

/**
 * Real Chromium against local HTTP and HTTPS servers (THE-183): proves what the
 * browser actually reports for TLS details, Set-Cookie headers and mixed
 * content, instead of trusting hand-written fakes.
 */

const chromiumPath = findLocalChromium();
function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const hasOpenssl = opensslAvailable();
if (!chromiumPath || !hasOpenssl) {
  console.warn(
    `[security-capture.browser.test] Skipped: ${!chromiumPath ? "no local Chromium (run `npx playwright install chromium`)" : "openssl not found"}.`,
  );
}

const listen = (server: Server) =>
  new Promise<number>((resolvePort) =>
    server.listen(0, "127.0.0.1", () =>
      resolvePort((server.address() as AddressInfo).port),
    ),
  );

describe.skipIf(!chromiumPath || !hasOpenssl)(
  "security evidence from a real browser",
  () => {
    let browser: Browser;
    let httpServer: Server;
    let httpsServer: Server;
    let httpPort = 0;
    let httpsPort = 0;
    let certDir = "";

    beforeAll(async () => {
      certDir = mkdtempSync(join(tmpdir(), "mortem-tls-"));
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(certDir, "key.pem"),
          "-out",
          join(certDir, "cert.pem"),
          "-days",
          "20",
          "-subj",
          "/CN=127.0.0.1",
        ],
        { stdio: "pipe" },
      );

      httpServer = createHttpServer((req, res) => {
        if (req.url === "/insecure.js") {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end("window.__insecure = true;");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": [
            "session_id=SECRET-SESSION-VALUE; Path=/",
            "theme=dark; Path=/; SameSite=Lax",
          ],
        });
        res.end("<!doctype html><title>plain http</title><p>hi</p>");
      });
      httpPort = await listen(httpServer);

      httpsServer = createHttpsServer(
        {
          key: readFileSync(join(certDir, "key.pem")),
          cert: readFileSync(join(certDir, "cert.pem")),
        },
        (_req, res) => {
          res.writeHead(200, {
            "content-type": "text/html",
            "strict-transport-security": "max-age=31536000",
            "set-cookie": [
              "auth_token=SECRET-TOKEN-VALUE; Path=/; Secure; HttpOnly; SameSite=Strict",
              "prefs=1; Path=/",
            ],
          });
          res.end(
            `<!doctype html><title>secure</title><p>hi</p><script src="http://${INSECURE_HOST}:${httpPort}/insecure.js"></script>`,
          );
        },
      ) as unknown as Server;
      httpsPort = await listen(httpsServer);

      // 127.0.0.1 counts as a trusted origin, so it is never mixed content.
      // Map a made-up host to it so the browser treats the script as insecure.
      browser = await chromium.launch({
        executablePath: chromiumPath!,
        headless: true,
        args: [`--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`],
      });
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      httpServer?.close();
      httpsServer?.close();
      if (certDir) rmSync(certDir, { recursive: true, force: true });
    }, 30_000);

    it("reads TLS details, cookie flags (without values) and Chrome's mixed-content message on HTTPS", async () => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const consoleTexts: string[] = [];
      page.on("console", (msg) => consoleTexts.push(msg.text()));
      const url = `https://127.0.0.1:${httpsPort}/`;
      const response = await page.goto(url, { waitUntil: "load" });
      const security = await collectDocumentSecurity(
        response as unknown as PlaywrightResponseLike,
        page.url(),
        [],
      );
      await context.close();

      expect(security.tlsUnavailableReason).toBeNull();
      expect(security.tls?.protocol).toMatch(/^TLS 1\.[23]$/);
      expect(security.tls?.subjectName).toBe("127.0.0.1");
      const daysLeft = Math.round(
        ((security.tls?.validTo ?? 0) * 1000 - Date.now()) / 86_400_000,
      );
      expect(daysLeft).toBeGreaterThanOrEqual(19);
      expect(daysLeft).toBeLessThanOrEqual(20);

      expect(security.cookiesUnavailableReason).toBeNull();
      expect(security.setCookies).toEqual([
        {
          name: "auth_token",
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
          domain: null,
          path: "/",
        },
        {
          name: "prefs",
          secure: false,
          httpOnly: false,
          sameSite: null,
          domain: null,
          path: "/",
        },
      ]);
      expect(JSON.stringify(security)).not.toContain("SECRET");

      // Chrome blocks the http:// script and says so in the console.
      const mixed = consoleTexts
        .map(parseMixedContentConsoleMessage)
        .filter((m) => m !== null);
      expect(mixed).toEqual([
        {
          url: `http://${INSECURE_HOST}:${httpPort}/insecure.js`,
          type: "script",
          active: true,
          source: "console",
        },
      ]);

      // End to end through the rules: expiring certificate is a TLS rule; here
      // the page rules flag the blocked script and the cookie without Secure.
      const violations = evaluateSecurityPageRules({
        pageId: "p",
        pageUrl: url,
        finalUrl: page.url(),
        headers: {
          "strict-transport-security": "max-age=31536000",
          "content-security-policy":
            "default-src 'self'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "permissions-policy": "camera=()",
        },
        security,
        mixedContent: mixed,
        evidence: { headers: "ev_h", consoleLog: "ev_c" },
      }).map((v) => v.ruleId);
      expect(violations).toEqual([
        "sec.mixed-content.active",
        "sec.cookie.secure-missing",
        "sec.cookie.samesite-missing",
      ]);
    }, 60_000);

    it("reports no TLS details for a plain-HTTP page instead of inventing them", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const response = await page.goto(`http://127.0.0.1:${httpPort}/`);
      const security = await collectDocumentSecurity(
        response as unknown as PlaywrightResponseLike,
        page.url(),
        [{ url: "http://x/y.js", resourceType: "script" }],
      );
      await context.close();
      expect(security.tls).toBeNull();
      expect(security.tlsUnavailableReason).toBe(
        "The page is not served over HTTPS.",
      );
      // Mixed content only exists on HTTPS pages.
      expect(security.insecureRequests).toEqual([]);
      expect(security.setCookies.map((c) => c.name)).toEqual([
        "session_id",
        "theme",
      ]);
      expect(JSON.stringify(security)).not.toContain("SECRET");
    }, 60_000);
  },
);

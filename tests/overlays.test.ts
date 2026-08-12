import { describe, test, expect } from 'bun:test';
import { chromium } from 'playwright';
import { DISMISS_OVERLAYS_JS } from '../src/capture/overlays.js';
import { findChromiumExecutable } from '../src/capture/pipeline.js';

describe('overlay dismissal', () => {
  test('keeps newsletter article content while removing cookie and modal chrome', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: findChromiumExecutable(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/workspace/bin/pw-browsers'),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      await page.setContent(`<!doctype html><html><body>
        <article class="typography newsletter-post post">${'Article text. '.repeat(500)}</article>
        <div class="cookieBanner" style="position:fixed;z-index:9999;width:100%;height:100px">Cookie settings</div>
        <div class="modal" style="position:fixed;z-index:9999;width:80%;height:300px">Subscribe</div>
      </body></html>`);
      await page.evaluate(DISMISS_OVERLAYS_JS);
      expect(await page.locator('article.newsletter-post').count()).toBe(1);
      expect((await page.locator('article').innerText()).length).toBeGreaterThan(4000);
      expect(await page.locator('.cookieBanner').count()).toBe(0);
      expect(await page.locator('.modal').count()).toBe(0);
    } finally {
      await browser.close();
    }
  }, 15_000);
});

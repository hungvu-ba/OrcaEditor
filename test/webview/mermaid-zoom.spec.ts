/**
 * bug_General #6: Mermaid diagram zoom via the shared fullscreen lightbox
 * (lightbox.ts). Clicking the toolbar "Zoom" button must open #md-lightbox with
 * the diagram's SVG (kept as vector), and Esc must close it. A second case guards
 * the image-zoom regression: the same shared lightbox still opens for images
 * (US-19.4) after the overlay was extracted out of image-zoom.ts.
 *
 * Needs the real webview engine (real click events, async mermaid.render, the
 * document keydown listener) — test/roundtrip/ (domino) cannot dispatch events.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './_harness';

test('Zoom button opens the diagram in the lightbox; Esc closes it', async ({ page }) => {
  await openEditor(page, '```mermaid\ngraph TD; A-->B; B-->C\n```\n');

  // mermaid.render is async — wait for the SVG to land in the chart.
  await page.locator('.md-mermaid-chart svg').waitFor();

  await page.locator('.md-mermaid-zoom').click();

  const lightbox = page.locator('#md-lightbox');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('#md-lightbox-stage svg')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
});

test('opened diagram is fit to the viewport, not shown at its small native size', async ({ page }) => {
  await openEditor(page, '```mermaid\ngraph TD; A-->B; B-->C\n```\n');
  await page.locator('.md-mermaid-chart svg').waitFor();

  await page.locator('.md-mermaid-zoom').click();
  const svg = page.locator('#md-lightbox-stage svg');
  await expect(svg).toBeVisible();

  // The SVG must be scaled up to (roughly) fill a viewport axis, not left at its
  // ~200px intrinsic size. Assert it reaches most of one available dimension.
  const { w, h, availW, availH } = await page.evaluate(() => {
    const el = document.querySelector('#md-lightbox-stage svg') as SVGElement;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, availW: window.innerWidth * 0.92, availH: window.innerHeight * 0.92 };
  });
  expect(w <= availW + 1 && h <= availH + 1).toBe(true); // within the fit box
  expect(w >= availW - 60 || h >= availH - 60).toBe(true); // fills one axis
});

test('Esc closing the lightbox is modal — does not fire other document Esc handlers', async ({ page }) => {
  await openEditor(page, '```mermaid\ngraph TD; A-->B\n```\n');
  await page.locator('.md-mermaid-chart svg').waitFor();

  // A stand-in for the other document-level Esc handlers (Zen exit, selection
  // clear, popovers) that must NOT fire while the modal lightbox is open.
  await page.evaluate(() => {
    (window as unknown as { __esc: number }).__esc = 0;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        (window as unknown as { __esc: number }).__esc++;
      }
    });
  });

  await page.locator('.md-mermaid-zoom').click();
  await expect(page.locator('#md-lightbox')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#md-lightbox')).toBeHidden();

  const escSeen = await page.evaluate(() => (window as unknown as { __esc: number }).__esc);
  expect(escSeen).toBe(0); // lightbox swallowed the Esc via capture + stopPropagation
});

test('image hover 🔍 still opens the same shared lightbox with an image', async ({ page }) => {
  await openEditor(page, 'text\n');

  // Inject an image sized >= 48px so the hover button is offered (positionBtn
  // skips tiny inline icons). 1x1 PNG stretched via CSS — natural size is
  // irrelevant, positionBtn reads the rendered rect.
  await page.locator('#content').evaluate((el) => {
    const img = document.createElement('img');
    img.src =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    img.style.width = '80px';
    img.style.height = '80px';
    el.querySelector('p')!.appendChild(img);
    img.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });

  const zoomBtn = page.locator('#img-zoom-btn');
  await expect(zoomBtn).toBeVisible();
  await zoomBtn.click();

  const lightbox = page.locator('#md-lightbox');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('#md-lightbox-stage img')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
});

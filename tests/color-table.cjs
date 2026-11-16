const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {})
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    const editor = page.locator('#editor');
    const popup = page.locator('#colorTablePopup');
    const cell = (color) => page.locator('.color-table-cell[data-color="' + color + '"]');
    async function selectText(text, start = 0, end = text.length) {
      await page.evaluate(({ text, start, end }) => {
        window.RichTextDisplay.setText(text);
        const node = document.getElementById('editor');
        node.focus(); node.setSelectionRange(start, end);
      }, { text, start, end });
    }
    async function checkPopupBounds() {
      const box = await popup.boundingBox(), viewport = page.viewportSize();
      assert.ok(box && box.x >= 0 && box.y >= 0);
      assert.ok(box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
    }

    await selectText('前缀目标文字后缀', 2, 6);
    await page.click('#textColorTable');
    assert.equal(await popup.isVisible(), true);
    assert.equal(await page.locator('.color-table-cell').count(), 80);
    await checkPopupBounds();
    await cell('#ff0000').click();
    assert.equal(await editor.inputValue(), '前缀<color=#ff0000>目标文字</color>后缀');
    assert.equal(await popup.isVisible(), false);
    assert.equal(await page.locator('#customColor').inputValue(), '#ff0000');
    await page.click('#textColorTable');
    assert.equal(await cell('#ff0000').getAttribute('aria-pressed'), 'true');
    await cell('#0000ff').click();
    assert.equal(await editor.inputValue(), '前缀<color=#0000ff>目标文字</color>后缀');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), '前缀<color=#ff0000>目标文字</color>后缀');
    await page.click('#textColorTable');
    await page.keyboard.press('Escape');
    assert.equal(await popup.isVisible(), false);
    assert.equal(await page.locator('#textColorTable').evaluate((node) => node === document.activeElement), true);
    await page.click('#textColorTable');
    await editor.click();
    assert.equal(await popup.isVisible(), false);
    console.log('PASS: 80-color table, text selection, replacing color, undo, selected-color marker and dismissal');

    const beforeDraft = await editor.inputValue();
    await page.fill('#favoriteColorHex', 'invalid');
    await page.click('#favoriteColorTable');
    await cell('#0070c0').click();
    assert.equal(await editor.inputValue(), beforeDraft);
    assert.equal(await page.locator('#favoriteColorHex').inputValue(), '#0070C0');
    assert.equal(await page.locator('#favoriteColorHex').evaluate((node) => node.validity.valid), true);
    await page.fill('#favoriteColorName', '色表蓝');
    await page.click('#saveFavoriteColor');
    await selectText('快捷换色');
    await page.locator('#favoriteColors .preset-apply[data-color="#0070c0"]').click();
    assert.equal(await editor.inputValue(), '<color=#0070c0>快捷换色</color>');
    await page.click('#gradientLibrary summary');
    await selectText('ABC');
    await page.locator('.gradient-table-button').first().click();
    await cell('#ff0000').click();
    await page.locator('.gradient-table-button').nth(1).click();
    await cell('#0000ff').click();
    assert.equal(await editor.inputValue(), 'ABC');
    assert.equal(await page.locator('.gradient-stop .hex-input').first().inputValue(), '#FF0000');
    await page.selectOption('#gradientMode', 'characters');
    await page.click('#applyGradient');
    assert.equal(await editor.inputValue(), '<color=#ff0000>A</color><color=#800080>B</color><color=#0000ff>C</color>');
    await page.fill('#gradientPresetName', '色表渐变');
    await page.click('#saveGradientPreset');
    await page.reload();
    assert.equal(await page.locator('#favoriteColors .preset-apply[data-color="#0070c0"]').count(), 1);
    await selectText('ABC');
    await page.locator('#gradientPresets .preset-apply').filter({ hasText: '色表渐变' }).click();
    assert.equal(await editor.inputValue(), '<color=#ff0000>A</color><color=#800080>B</color><color=#0000ff>C</color>');
    console.log('PASS: chart colors feed favorites, gradient stops and persisted presets without editing text prematurely');

    await page.click('#textColorTable');
    await cell('#ffffff').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.color), '#f2f2f2');
    await page.keyboard.press('Enter');
    assert.equal(await editor.inputValue(), '<color=#f2f2f2>ABC</color>');
    const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'richtext-chart-test-'));
    await page.click('#textColorTable');
    await page.screenshot({ path: path.join(artifacts, 'desktop-table.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator('.gradient-table-button').first().click();
    await checkPopupBounds();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'mobile-table.png') });
    await cell('#ffff00').click();
    assert.equal(await page.locator('.gradient-stop .hex-input').first().inputValue(), '#FFFF00');
    assert.deepEqual(errors, []);
    console.log('PASS: keyboard navigation and 320px popup/gradient layout');
    console.log('Artifacts:', artifacts);
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

// Browser integration tests. See README for PLAYWRIGHT_MODULE / BROWSER_PATH.
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
    const url = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
    await page.goto(url);
    const editor = page.locator('#editor');
    const value = () => editor.inputValue();
    async function selectText(text, start = 0, end = text.length) {
      await page.evaluate(({ text, start, end }) => {
        window.RichTextDisplay.setText(text);
        const editor = document.getElementById('editor');
        editor.focus(); editor.setSelectionRange(start, end);
      }, { text, start, end });
    }
    async function undo() { await editor.press('Control+z'); }
    async function gradientColors(colors) {
      if (!(await page.locator('#gradientLibrary').evaluate((node) => node.open))) await page.click('#gradientLibrary summary');
      while (await page.locator('.gradient-stop').count() < colors.length) await page.click('#addGradientStop');
      while (await page.locator('.gradient-stop').count() > colors.length) await page.locator('.remove-stop').last().click();
      for (let index = 0; index < colors.length; index++) await page.locator('.gradient-stop .hex-input').nth(index).fill(colors[index]);
    }
    const favorite = (color) => page.locator('#favoriteColors .preset-apply[data-color="' + color + '"]');
    const preset = (name) => page.locator('#gradientPresets .preset-apply').filter({ hasText: name });

    assert.equal(await page.locator('#favoriteColors .preset-apply').count(), 5);
    await selectText('甲乙丙丁', 1, 3);
    await favorite('#e5484d').click();
    assert.equal(await value(), '甲<color=#e5484d>乙丙</color>丁');
    await favorite('#1c7ed6').click();
    assert.equal(await value(), '甲<color=#1c7ed6>乙丙</color>丁');
    await undo(); assert.equal(await value(), '甲<color=#e5484d>乙丙</color>丁');
    await undo(); assert.equal(await value(), '甲乙丙丁');
    await page.fill('#favoriteColorHex', '#12AB34');
    await page.fill('#favoriteColorName', '青草');
    await page.click('#saveFavoriteColor');
    assert.equal(await value(), '甲乙丙丁'); // Saving a preset is not an editor edit.
    await favorite('#12ab34').click();
    assert.equal(await value(), '甲<color=#12ab34>乙丙</color>丁');
    await page.click('#saveFavoriteColor');
    assert.equal(await favorite('#12ab34').count(), 1);
    await page.fill('#favoriteColorHex', 'badhex');
    await page.click('#saveFavoriteColor');
    assert.equal(await page.locator('#favoriteColorHex').evaluate((node) => node.validity.valid), false);
    assert.equal(await page.locator('#favoriteColors .preset-apply').count(), 6);
    await page.fill('#favoriteColorHex', '#fff');
    await page.fill('#favoriteColorName', '白色');
    await page.click('#saveFavoriteColor');
    assert.equal(await favorite('#ffffff').count(), 1);
    await page.locator('#customColor').fill('#aabbcc');
    await page.click('#saveCurrentColor');
    assert.equal(await favorite('#aabbcc').count(), 1);
    await page.click('#colorLibrary summary');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('richtext-paint-library-v1')).colorOpen === false);
    await page.reload();
    assert.equal(await page.locator('#colorLibrary').evaluate((node) => node.open), false);
    await page.click('#colorLibrary summary');
    assert.equal(await favorite('#12ab34').count(), 1);
    await page.getByRole('button', { name: '删除颜色：白色', exact: true }).click();
    assert.equal(await favorite('#ffffff').count(), 0);
    console.log('PASS: one-click recolor, undo, save/deduplicate/delete favorites, custom-color shortcut and persisted visibility');

    await selectText('ABCDE', 1, 4);
    await gradientColors(['#FF0000', '#0000FF']);
    await page.click('#applyGradient');
    assert.equal(await value(), 'A<gradient=#ff0000,#0000ff>BCD</gradient>E');
    await page.locator('.gradient-stop select').first().selectOption('#12ab34');
    await page.click('#applyGradient');
    assert.equal(await value(), 'A<gradient=#12ab34,#0000ff>BCD</gradient>E');
    await gradientColors(['#FF0000', '#0000FF']);
    await page.selectOption('#gradientMode', 'characters');
    await page.click('#applyGradient');
    const perCharacter = 'A<color=#ff0000>B</color><color=#800080>C</color><color=#0000ff>D</color>E';
    assert.equal(await value(), perCharacter);
    await page.fill('#gradientPresetName', '红蓝逐字');
    await page.click('#saveGradientPreset');
    await page.selectOption('#gradientMode', 'tag');
    await page.fill('#gradientPresetName', '红蓝标签');
    await page.click('#saveGradientPreset');
    await preset('红蓝逐字').click();
    assert.equal(await page.locator('#gradientMode').inputValue(), 'characters');
    assert.equal(await value(), perCharacter);
    await preset('红蓝标签').click();
    assert.equal(await value(), 'A<gradient=#ff0000,#0000ff>BCD</gradient>E');
    await undo(); assert.equal(await value(), perCharacter);
    await favorite('#12ab34').click();
    assert.equal(await value(), 'A<color=#12ab34>BCD</color>E');
    await preset('红蓝标签').click();
    assert.equal(await value(), 'A<gradient=#ff0000,#0000ff>BCD</gradient>E');
    const beforeLoad = await value();
    await page.getByRole('button', { name: '调色：红蓝逐字', exact: true }).click();
    assert.equal(await value(), beforeLoad);
    await page.click('#reverseGradient');
    await page.click('#saveGradientPreset'); // Same name updates this preset.
    assert.equal(await preset('红蓝逐字').count(), 1);
    await page.reload();
    assert.equal(await page.locator('#gradientLibrary').evaluate((node) => node.open), true);
    await selectText('XYZ');
    await preset('红蓝逐字').click();
    assert.equal(await value(), '<color=#0000ff>X</color><color=#800080>Y</color><color=#ff0000>Z</color>');
    await page.getByRole('button', { name: '删除渐变预设：红蓝标签', exact: true }).click();
    assert.equal(await preset('红蓝标签').count(), 0);
    console.log('PASS: editable stops, saved-color shortcuts, both output modes, one-click preset application, update/reload/delete');

    await gradientColors(['#ff0000', '#0000ff']);
    await page.selectOption('#gradientMode', 'characters');
    const unicode = '<b>你😀</b>\ne\u0301👨‍👩‍👧‍👦<br>好';
    await selectText(unicode);
    await page.click('#applyGradient');
    const generated = await value();
    const tokens = Array.from(generated.matchAll(/<color=(#[a-f0-9]{6})>(.*?)<\/color>/gs));
    assert.deepEqual(tokens.map((token) => token[2]), ['你', '😀', 'e\u0301', '👨‍👩‍👧‍👦', '好']);
    assert.deepEqual(tokens.map((token) => token[1]), ['#ff0000', '#bf0040', '#800080', '#4000bf', '#0000ff']);
    assert.match(generated, /^<b>/);
    assert.ok(generated.includes('</b>\n'));
    assert.ok(generated.includes('<br>'));
    assert.equal(await page.locator('#preview [data-tag="b"]').count(), 1);
    await undo(); assert.equal(await value(), unicode);
    await gradientColors(['#000000', '#ffffff', '#ff0000']);
    await selectText('甲乙丙'); await page.click('#applyGradient');
    assert.equal(await value(), '<color=#000000>甲</color><color=#ffffff>乙</color><color=#ff0000>丙</color>');
    await selectText('字'); await page.click('#applyGradient');
    assert.equal(await value(), '<color=#000000>字</color>');
    await selectText(''); await page.click('#applyGradient');
    assert.ok((await value()).includes('渐</color>'));
    await page.locator('.gradient-stop .hex-input').first().fill('#ZZZZZZ');
    const beforeInvalid = await value();
    await page.click('#applyGradient'); assert.equal(await value(), beforeInvalid);
    await page.locator('.gradient-stop .hex-input').first().fill('#000000');
    while (await page.locator('.gradient-stop').count() < 6) await page.click('#addGradientStop');
    assert.equal(await page.locator('#addGradientStop').isDisabled(), true);
    while (await page.locator('.gradient-stop').count() > 2) await page.locator('.remove-stop').last().click();
    assert.equal(await page.locator('.remove-stop').first().isDisabled(), true);
    console.log('PASS: grapheme clusters, markup/newlines, exact multi-stop interpolation, singleton/empty selection and input limits');

    // Names are text, and malformed persisted data cannot create HTML or break startup.
    await page.fill('#gradientPresetName', '<img src=x onerror=x>');
    await page.click('#saveGradientPreset');
    assert.equal(await page.locator('#gradientPresets img').count(), 0);
    const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'richtext-paint-test-'));
    await selectText('常用颜色与逐字渐变'); await preset('海风').click();
    await page.locator('.editor-panel').screenshot({ path: path.join(artifacts, 'desktop-editor.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.editor-panel').screenshot({ path: path.join(artifacts, 'mobile-editor.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok((await editor.boundingBox()).height >= 220);
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => localStorage.setItem('richtext-paint-library-v1', JSON.stringify({ colors: [null, { color: 'red' }], gradients: [{ colors: ['bad'], mode: 'x' }], draft: null })));
    await page.reload();
    assert.equal(await page.locator('#favoriteColors .preset-apply').count(), 0);
    await selectText('测试'); await page.click('.tool[data-tag="gradient"]');
    assert.match(await value(), /<gradient=#f08c00,#e5484d>测试<\/gradient>/);
    assert.deepEqual(errors, []);
    console.log('PASS: untrusted names/settings, mobile layouts and usable text area');
    console.log('Artifacts:', artifacts);
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

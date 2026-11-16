// Run with Node.js and Playwright. Set PLAYWRIGHT_MODULE and BROWSER_PATH if needed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'richtext-converter-test-'));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {})
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    assert.match(await page.locator('#preview').innerText(), /富文本显示器/);
    assert.equal(await page.locator('#convertImages').isDisabled(), true);

    async function fixture(name, width, height, rgba) {
      const data = await page.evaluate(({ width, height, rgba }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        return canvas.toDataURL().split(',')[1];
      }, { width, height, rgba });
      return { name, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
    }
    async function load(files) {
      if (!(await page.locator('#clearImages').isDisabled())) await page.click('#clearImages');
      await page.setInputFiles('#imageFiles', files);
      await page.waitForFunction(() => !document.querySelector('#sourceInfo').textContent.startsWith('正在读取'));
    }
    async function grid(cols, rows) {
      await page.locator('#keepAspect').uncheck();
      await page.fill('#gridCols', String(cols)); await page.fill('#gridRows', String(rows));
    }
    async function convert() {
      await page.click('#convertImages');
      await page.waitForFunction(() => document.querySelector('#conversionStatus').textContent.startsWith('已完成'));
      assert.equal(await page.locator('#convertImages').isDisabled(), false);
      return page.locator('#editor').inputValue();
    }
    async function pixels() {
      return page.locator('#preview canvas').evaluate((canvas) => ({
        width: canvas.width, height: canvas.height,
        rgba: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)
      }));
    }
    async function download(button, filename) {
      const pending = page.waitForEvent('download');
      await page.click(button);
      const file = await pending;
      const target = path.join(artifacts, filename || file.suggestedFilename());
      await file.saveAs(target);
      return { target, name: file.suggestedFilename(), content: await fs.readFile(target) };
    }

    const sourcePixels = [240,0,0,255, 240,0,0,255, 0,0,240,255, 0,0,240,255, 0,0,0,0, 0,240,0,255];
    const sample = await fixture('颜色样例.png', 3, 2, sourcePixels);
    await load(sample);
    await grid(3, 2);
    await page.locator('#removeBackground').uncheck();
    await page.fill('#outputOffset', '3');
    const expected = '<size=5%><line-height=50%><voffset=0.08em><color=#F00000>██<color=#0000F0>█\n█<color=#00000000>█<color=#00F000>█</color></voffset></line-height></size>';
    assert.equal(await convert(), expected);
    assert.deepEqual((await pixels()).rgba, sourcePixels);
    assert.equal((await download('#downloadText')).name, '颜色样例.txt');
    assert.equal((await download('#downloadText', 'sample.txt')).content.toString('utf8'), expected);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.copiedText = value; } } });
    });
    await page.click('#copyText');
    assert.equal(await page.evaluate(() => window.copiedText), expected);
    await download('#exportImage', 'sample-preview.png');
    await page.selectOption('#renderMode', 'text');
    assert.equal(await page.locator('#preview [data-tag="voffset"]').count(), 1);
    assert.equal(await page.locator('#preview canvas').count(), 0);
    await page.selectOption('#renderMode', 'auto');
    await page.locator('#streamColors').uncheck();
    const closed = await convert();
    assert.equal((closed.match(/<color=/g) || []).length, (closed.match(/<\/color>/g) || []).length);
    assert.deepEqual((await pixels()).rgba, sourcePixels);
    console.log('PASS: stream/closed tags, cross-row color, transparency, offset, text/PNG export and copy');

    // Border-connected black is removed; isolated and diagonal interior black survives.
    const flood = [];
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const black = x === 0 || x === 6 || y === 0 || y === 6 || (x === 3 && y === 3) || (x === 2 && y === 2);
      flood.push(...(black ? [0,0,0,255] : [240,240,240,255]));
    }
    await load(await fixture('去黑底.png', 7, 7, flood));
    await grid(7, 7);
    await page.locator('#removeBackground').check();
    await convert();
    const result = await pixels();
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      assert.equal(result.rgba[(y * 7 + x) * 4 + 3], x === 0 || x === 6 || y === 0 || y === 6 ? 0 : 255);
    }
    await load(await fixture('阈值.png', 1, 1, [64,64,64,255]));
    await grid(1, 1);
    await page.fill('#backgroundThreshold', '64');
    await convert(); assert.equal((await pixels()).rgba[3], 255);
    await page.fill('#backgroundThreshold', '65');
    await convert(); assert.equal((await pixels()).rgba[3], 0);
    await load(await fixture('半透明.png', 2, 1, [255,0,0,128, 0,0,0,0]));
    await grid(2, 1);
    await page.locator('#removeBackground').uncheck();
    await convert(); assert.deepEqual((await pixels()).rgba, [239,0,0,128, 0,0,0,0]); // Canvas readback unpremultiplies to 239.
    await page.locator('#preserveAlpha').uncheck();
    await convert(); assert.equal((await pixels()).rgba[3], 255);
    console.log('PASS: four-neighbor background flood fill, strict threshold, transparent and half-transparent pixels');

    // Multiple images, duplicate basenames, per-image aspect ratio, and corrupt input.
    const wide = await fixture('同名.png', 4, 2, Array(8).fill([240,16,32,255]).flat());
    const tall = await fixture('同名.jpg', 2, 4, Array(8).fill([16,32,240,255]).flat());
    await load([wide, tall, { name: '损坏.png', mimeType: 'image/png', buffer: Buffer.from('invalid png') }]);
    await page.locator('#keepAspect').check();
    await page.fill('#gridCols', '4');
    await page.locator('#streamColors').check();
    await page.fill('#outputOffset', '0');
    await convert();
    assert.match(await page.locator('#conversionStatus').innerText(), /已完成 2 \/ 3/);
    assert.equal((await pixels()).height, 2);
    const firstText = await page.locator('#editor').inputValue();
    await page.selectOption('#imageList', '1');
    assert.equal((await pixels()).height, 8);
    assert.equal(await page.locator('#editorFilename').innerText(), '同名 (2).txt');
    const secondText = await page.locator('#editor').inputValue();
    const zip = await download('#downloadBatch');
    assert.equal(zip.name, 'richtext_out.zip');
    await fs.writeFile(path.join(artifacts, 'zip-expected.json'), JSON.stringify({ '同名.txt': firstText, '同名 (2).txt': secondText }));
    await page.fill('#editor', '<b>编辑后的内容</b>');
    assert.equal((await download('#downloadText', 'edited.txt')).content.toString('utf8'), '<b>编辑后的内容</b>');
    assert.deepEqual((await download('#downloadBatch', 'after-edit.zip')).content, zip.content);
    await page.fill('#gridCols', '0');
    await page.click('#convertImages');
    assert.equal(await page.locator('#gridCols').evaluate((input) => input.validity.valid), false);
    assert.equal(await page.locator('#editor').inputValue(), '<b>编辑后的内容</b>');
    console.log('PASS: batch, aspect ratio, duplicate output names, partial failure, ZIP snapshot and edited TXT');

    // Real project fixture, desktop/mobile layout, local settings, and text regression.
    await page.setInputFiles('#imageFiles', path.resolve(__dirname, '../richtext_out/preview_8A9DA690D785CF95571F6483EEE3D011.png'));
    await page.waitForFunction(() => document.querySelector('#sourceInfo').textContent.includes('350 × 350'));
    await page.click('#clearImages');
    await page.setInputFiles('#imageFiles', path.resolve(__dirname, '../richtext_out/preview_8A9DA690D785CF95571F6483EEE3D011.png'));
    await page.waitForFunction(() => document.querySelector('#sourceInfo').textContent.includes('350 × 350'));
    await grid(70, 70); await convert();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.selectOption('#pixelZoom', '12');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.selectOption('#pixelZoom', 'fit');
    await page.setInputFiles('#textFile', path.resolve(__dirname, '../richtext_out/8A9DA690D785CF95571F6483EEE3D011.txt'));
    await page.waitForFunction(() => document.querySelector('#editor').value.startsWith('<size=5%>'));
    assert.equal((await pixels()).width, 70);
    await page.click('#exampleButton');
    assert.match(await page.locator('#preview').innerText(), /富文本显示器/);
    await page.evaluate(() => window.RichTextDisplay.setText('<script>alert(1)</script><b>安全</b>'));
    assert.equal(await page.locator('#preview script').count(), 0);
    await page.click('#clearButton');
    assert.equal(await page.locator('#emptyState').isVisible(), true);
    assert.equal(await page.locator('#downloadText').isDisabled(), true);
    await page.reload();
    assert.equal(await page.locator('#gridCols').inputValue(), '70');
    assert.equal(await page.locator('#fileSummary').innerText(), '0 张图片');
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    console.log('PASS: existing TXT/text rendering, responsive layout, settings persistence and no network requests');
    console.log('Artifacts:', artifacts);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

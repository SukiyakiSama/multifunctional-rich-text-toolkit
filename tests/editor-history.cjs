// Run with Node.js and Playwright, using PLAYWRIGHT_MODULE / BROWSER_PATH as needed.
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
    const text = () => editor.inputValue();
    const undo = () => editor.press('Control+z');
    const redo = () => editor.press('Control+Shift+z');
    async function select(start, end = start, direction = 'forward') {
      await editor.evaluate((node, range) => {
        node.focus(); node.setSelectionRange(...range);
      }, [start, end, direction]);
    }
    async function setText(value) { await page.evaluate((value) => window.RichTextDisplay.setText(value), value); }
    async function selection() { return editor.evaluate((node) => [node.selectionStart, node.selectionEnd, node.selectionDirection]); }

    assert.equal(await page.locator('#undoButton').isDisabled(), true);
    assert.equal(await page.locator('#redoButton').isDisabled(), true);
    await setText('前缀渐变测试后缀');
    await select(2, 6, 'backward');
    const originalSelection = await selection();
    await page.click('.tool[data-tag="gradient"]');
    const formatted = await text();
    const formattedSelection = await selection();
    assert.equal(formatted, '前缀<gradient=#f08c00,#e5484d>渐变测试</gradient>后缀');
    await undo();
    assert.equal(await text(), '前缀渐变测试后缀');
    assert.deepEqual(await selection(), originalSelection);
    assert.equal(await page.locator('#preview [data-tag="gradient"]').count(), 0);
    await redo();
    assert.equal(await text(), formatted);
    assert.deepEqual(await selection(), formattedSelection);
    await page.click('#undoButton');
    assert.equal(await text(), '前缀渐变测试后缀');
    await page.click('#redoButton');
    assert.equal(await text(), formatted);
    await undo(); await editor.press('Control+y');
    assert.equal(await text(), formatted);
    console.log('PASS: gradient undo/redo via keyboard and buttons restores text and selection');

    await setText('abc'); await select(3);
    await editor.pressSequentially('DEF');
    await select(3, 6);
    await page.click('.tool[data-tag="b"]');
    const bold = await text();
    await undo(); assert.equal(await text(), 'abcDEF');
    await undo(); assert.equal(await text(), 'abc');
    await redo(); assert.equal(await text(), 'abcDEF');
    await redo(); assert.equal(await text(), bold);
    await undo();
    await editor.pressSequentially('new');
    assert.equal(await text(), 'abcnew');
    assert.equal(await page.locator('#redoButton').isDisabled(), true);
    await redo(); assert.equal(await text(), 'abcnew');
    await undo(); assert.equal(await text(), 'abcDEF');
    await select(6);
    await editor.press('Backspace'); await editor.press('Backspace');
    assert.equal(await text(), 'abcD');
    await undo(); assert.equal(await text(), 'abcDEF');
    await editor.press('Tab'); assert.equal(await text(), 'abcDEF  ');
    await undo(); assert.equal(await text(), 'abcDEF');
    await page.selectOption('#sizeSelect', '32');
    assert.match(await text(), /<size=32>/);
    await undo(); assert.equal(await text(), 'abcDEF');
    await page.click('.cheat-card[data-demo="gradient"]');
    assert.match(await text(), /<gradient=/);
    await undo(); assert.equal(await text(), 'abcDEF');
    console.log('PASS: typing/deletion groups, mixed formatting, Tab, demos and branching after undo');

    await page.setInputFiles('#textFile', { name: '测试.txt', mimeType: 'text/plain', buffer: Buffer.from('导入的文字') });
    await page.waitForFunction(() => document.querySelector('#editorFilename').textContent === '测试.txt');
    assert.equal(await text(), '导入的文字');
    await page.click('#clearButton');
    assert.equal(await text(), '');
    await undo();
    assert.equal(await text(), '导入的文字');
    assert.equal(await page.locator('#editorFilename').innerText(), '测试.txt');
    await undo();
    assert.equal(await text(), 'abcDEF');
    assert.equal(await page.locator('#editorFilename').innerText(), 'richtext.txt');
    await page.click('#exampleButton'); await undo();
    assert.equal(await text(), 'abcDEF');
    console.log('PASS: import, filename, clear and example replacement are reversible');

    // Real Chromium composition events: candidates should form one undo step.
    await setText('输入：'); await select(3);
    const client = await page.context().newCDPSession(page);
    await client.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await client.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 });
    await client.send('Input.insertText', { text: '你好' });
    assert.equal(await text(), '输入：你好');
    await undo(); assert.equal(await text(), '输入：');
    await redo(); assert.equal(await text(), '输入：你好');
    // Also exercise cancelable browser menu/history events, without a keydown.
    await editor.evaluate((node) => node.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })));
    assert.equal(await text(), '输入：');
    await editor.evaluate((node) => node.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true })));
    assert.equal(await text(), '输入：你好');
    console.log('PASS: Chinese IME composition and browser history input events');

    await setText('滚动测试\n'.repeat(400));
    await select(1000, 1004);
    await editor.evaluate((node) => { node.scrollTop = 600; });
    const scrollTop = await editor.evaluate((node) => node.scrollTop);
    await page.click('.tool[data-tag="gradient"]');
    await undo();
    assert.equal(await editor.evaluate((node) => node.scrollTop), scrollTop);

    // Large pixel art still round-trips through clear and history without losing data.
    const samplePath = path.resolve(__dirname, '../richtext_out/8A9DA690D785CF95571F6483EEE3D011.txt');
    await page.setInputFiles('#textFile', samplePath);
    await page.waitForSelector('#preview canvas');
    const pixelSource = await text();
    await page.click('#clearButton'); await undo();
    assert.equal(await text(), pixelSource);
    assert.equal(await page.locator('#preview canvas').evaluate((canvas) => canvas.width), 70);

    const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'richtext-history-test-'));
    await page.locator('.editor-panel').screenshot({ path: path.join(artifacts, 'desktop-editor.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.editor-panel').screenshot({ path: path.join(artifacts, 'mobile-editor.png') });
    assert.equal(await page.locator('#undoButton').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    // Bound the number of history entries, and never fall back to stale native undo.
    await page.evaluate(() => { for (let index = 0; index < 110; index++) window.RichTextDisplay.setText('记录 ' + index); });
    for (let index = 0; index < 100; index++) await undo();
    assert.equal(await text(), '记录 9');
    assert.equal(await page.locator('#undoButton').isDisabled(), true);
    await undo(); assert.equal(await text(), '记录 9');
    assert.deepEqual(errors, []);
    console.log('PASS: scroll position, pixel text, mobile buttons and history limits');
    console.log('Artifacts:', artifacts);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

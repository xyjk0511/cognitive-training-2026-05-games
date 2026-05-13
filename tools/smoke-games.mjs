import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/source-contracts.json'), 'utf8'));
const entries = Object.entries(contracts).map(([id, contract]) => ({ id, rel: contract.entry, abs: path.join(ROOT, contract.entry) }));

for (const entry of entries) {
  const html = fs.readFileSync(entry.abs, 'utf8');
  if (!html.includes('<html') || !html.includes('</html>')) throw new Error(`${entry.id} entry is not complete HTML`);
}

let playwright = null;
try {
  playwright = await import('playwright');
} catch {
  try {
    playwright = createRequire(import.meta.url)('playwright');
  } catch {
    console.log('Playwright is not installed; completed static smoke for all entry HTML files.');
    for (const entry of entries) console.log(`static-ok ${entry.id} ${entry.rel}`);
    process.exit(0);
  }
}

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const decoded = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const target = path.resolve(ROOT, decoded || 'MANIFEST.md');
  if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': mime.get(path.extname(target).toLowerCase()) || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('favicon.ico')) errors.push(msg.text());
  });
  for (const entry of entries) {
    const url = `http://127.0.0.1:${port}/${encodeURI(entry.rel).replaceAll('%2F', '/')}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    const button = await page.locator('button').first();
    if (await button.count()) await button.click({ timeout: 1000 }).catch(() => {});
    console.log(`browser-ok ${entry.id} ${entry.rel}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  server.close();
}

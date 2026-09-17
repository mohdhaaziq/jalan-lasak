#!/usr/bin/env node
/* Regenerate the app icons from tools/icon.svg with headless Chrome — no npm
   dependencies. The maskable icon keeps the art inside the 80% safe zone.

     node tools/make-icons.js            # uses Chrome at $CHROME or the macOS default
*/
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'assets', 'icons');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');

function render(size, inset, file) {
  const art = size * (1 - 2 * inset);
  const off = size * inset;
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#201e1d;width:${size}px;height:${size}px;overflow:hidden">
    <div style="position:absolute;left:${off}px;top:${off}px;width:${art}px;height:${art}px">${svg.replace('<svg ', `<svg width="${art}" height="${art}" `)}</div>
  </body></html>`;
  const tmp = path.join(os.tmpdir(), `jl-icon-${size}-${inset}.html`);
  fs.writeFileSync(tmp, html);
  const dest = path.join(OUT, file);
  execFileSync(CHROME, [
    '--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1', '--no-sandbox',
    `--window-size=${size},${size}`, `--screenshot=${dest}`, 'file://' + tmp
  ], { stdio: 'ignore' });
  fs.unlinkSync(tmp);
  console.log('wrote', path.relative(ROOT, dest));
}

fs.mkdirSync(OUT, { recursive: true });
render(512, 0.08, 'icon-512.png');
render(192, 0.08, 'icon-192.png');
render(180, 0.08, 'icon-180.png');           // apple-touch-icon
render(512, 0.20, 'maskable-512.png');       // inside the 80% safe zone
fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg);
console.log('wrote', path.relative(ROOT, path.join(OUT, 'favicon.svg')));

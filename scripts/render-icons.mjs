// Рендер favicon-PNG из векторного бренд-знака public/brand/icon.svg.
// Движок: @resvg/resvg-js (Rust resvg, без системных зависимостей).
// Запуск: npm run icons  →  public/icons/{16,32,48,128}.png
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const SIZES = [16, 32, 48, 128];
const SRC = 'public/brand/icon.svg';
const OUT_DIR = 'public/icons';

const svg = readFileSync(SRC, 'utf8');
mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  writeFileSync(`${OUT_DIR}/${size}.png`, png);
  console.log(`icon ${size}x${size} -> ${OUT_DIR}/${size}.png`);
}

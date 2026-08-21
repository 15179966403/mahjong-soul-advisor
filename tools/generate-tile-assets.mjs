import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'public/assets/tiles');
const numerals = '一二三四五六七八九'.split('');
const colors = { ink: '#19352f', red: '#bb352e', blue: '#266b91', green: '#257152' };

function svgFrame(code, label, face) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 145" role="img" aria-labelledby="title-${code}">
  <title id="title-${code}">${label}</title>
  <g transform="translate(-1 1)" opacity=".96">${face}</g>
</svg>\n`;
}

function text(x, y, value, size, fill, weight = 700) {
  return `<text x="${x}" y="${y}" text-anchor="middle" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="Kaiti SC, STKaiti, Songti SC, serif">${value}</text>`;
}

function manFace(rank) {
  const numeralColor = rank === 5 ? colors.red : colors.ink;
  return `${text(47, 67, numerals[rank - 1], 35, numeralColor)}${text(47, 103, '萬', 27, colors.red)}`;
}

function pip(x, y, radius, color, large = false) {
  const inner = large ? radius * .52 : radius * .44;
  return `<g transform="translate(${x} ${y})">
    <circle r="${radius}" fill="none" stroke="${color}" stroke-width="${large ? 2.5 : 2}"/>
    <circle r="${inner}" fill="none" stroke="${color}" stroke-width="1.25"/>
    <circle r="${large ? 2.3 : 1.65}" fill="${color}"/>
    <path d="M0-${inner}V${inner}M-${inner} 0H${inner}M-${inner * .72}-${inner * .72}L${inner * .72} ${inner * .72}M${inner * .72}-${inner * .72}L-${inner * .72} ${inner * .72}" stroke="${color}" stroke-width=".7"/>
  </g>`;
}

const pinLayouts = {
  2: [[35, 49], [59, 92]],
  3: [[34, 47], [47, 71], [60, 95]],
  4: [[34, 49], [60, 49], [34, 92], [60, 92]],
  5: [[34, 47], [60, 47], [47, 71], [34, 95], [60, 95]],
  6: [[35, 43], [59, 43], [35, 71], [59, 71], [35, 99], [59, 99]],
  7: [[47, 39], [35, 63], [59, 63], [35, 82], [59, 82], [35, 101], [59, 101]],
  8: [[35, 39], [59, 39], [35, 60], [59, 60], [35, 82], [59, 82], [35, 103], [59, 103]],
  9: [[32, 43], [47, 43], [62, 43], [32, 71], [47, 71], [62, 71], [32, 99], [47, 99], [62, 99]],
};

function pinFace(rank) {
  if (rank === 1) return pip(47, 71, 18, colors.blue, true);
  return pinLayouts[rank].map(([x, y], index) => {
    const color = rank === 5 && index === 2 ? colors.red : index % 3 === 1 ? colors.red : index % 2 ? colors.blue : colors.green;
    return pip(x, y, rank >= 8 ? 5.2 : 6.2, color);
  }).join('');
}

function bamboo(x, y, color, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <rect x="-3.1" y="-12" width="6.2" height="24" rx="3" fill="${color}"/>
    <path d="M-3-4H3M-3 4H3" stroke="#f7dfaa" stroke-width="1.3" opacity=".85"/>
    <path d="M-2-9L2-12M-2 12L2 9" stroke="#d8b866" stroke-width="1" opacity=".7"/>
  </g>`;
}

const souLayouts = {
  2: [[37, 50], [57, 92]],
  3: [[47, 42], [34, 91], [60, 91]],
  4: [[35, 49], [59, 49], [35, 93], [59, 93]],
  5: [[35, 45], [59, 45], [47, 71], [35, 98], [59, 98]],
  6: [[35, 43], [59, 43], [35, 71], [59, 71], [35, 99], [59, 99]],
  7: [[47, 38], [35, 62], [59, 62], [35, 82], [59, 82], [35, 102], [59, 102]],
  8: [[35, 38], [59, 38], [35, 60], [59, 60], [35, 82], [59, 82], [35, 104], [59, 104]],
  9: [[32, 40], [47, 40], [62, 40], [32, 71], [47, 71], [62, 71], [32, 102], [47, 102], [62, 102]],
};

function birdFace() {
  return `<g transform="translate(47 72)">
    <path d="M2-29C-4-21-3-12 3-5C-10-11-22-7-25 4C-13 2-5 6-1 15C-6 20-10 25-10 31M3-5C12-17 23-17 28-9C17-8 12-2 11 7C18 13 20 21 16 29C9 21 2 18-1 15" fill="none" stroke="${colors.green}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M3-5C8 2 7 11-1 15M7-19L15-25" fill="none" stroke="${colors.red}" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="9" cy="-20" r="2" fill="${colors.blue}"/>
  </g>`;
}

function souFace(rank) {
  if (rank === 1) return birdFace();
  return souLayouts[rank].map(([x, y], index) => bamboo(x, y, rank === 5 && index === 2 ? colors.red : index % 3 === 1 ? colors.blue : colors.green, rank >= 7 ? .78 : .9)).join('');
}

function honorFace(rank) {
  const honors = ['東', '南', '西', '北', '白', '發', '中'];
  if (rank === 5) {
    return `<rect x="26" y="43" width="42" height="57" rx="3" fill="none" stroke="${colors.blue}" stroke-width="3"/>
      <rect x="31" y="48" width="32" height="47" rx="1" fill="none" stroke="${colors.blue}" stroke-width="1" opacity=".6"/>
      ${text(47, 120, '白', 11, colors.blue, 600)}`;
  }
  const fill = rank === 6 ? colors.green : rank === 7 ? colors.red : colors.ink;
  return text(47, 91, honors[rank - 1], 45, fill);
}

await mkdir(outputDir, { recursive: true });
const generated = [];

for (let rank = 1; rank <= 9; rank += 1) {
  for (const [suit, name, face] of [
    ['m', '万', manFace(rank)],
    ['p', '筒', pinFace(rank)],
    ['s', '索', souFace(rank)],
  ]) {
    const code = `${rank}${suit}`;
    await writeFile(path.join(outputDir, `${code}.svg`), svgFrame(code, `${numerals[rank - 1]}${name}`, face));
    generated.push(code);
  }
}

const honorNames = ['东', '南', '西', '北', '白', '发', '中'];
for (let rank = 1; rank <= 7; rank += 1) {
  const code = `${rank}z`;
  await writeFile(path.join(outputDir, `${code}.svg`), svgFrame(code, honorNames[rank - 1], honorFace(rank)));
  generated.push(code);
}

console.log(`Generated ${generated.length} tile faces in ${path.relative(root, outputDir)}`);

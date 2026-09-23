const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const svgDir = path.join(rootDir, 'icon-build', 'svg');
const mediaDir = path.join(rootDir, 'media');
const iconSvg = path.join(svgDir, 'ollama-tracker.svg');
const svgFontPath = path.join(mediaDir, 'ollama-tracker-103.svg');
const ttfPath = path.join(mediaDir, 'ollama-tracker-103.ttf');
const woffPath = path.join(mediaDir, 'ollama-tracker-103.woff');

if (!fs.existsSync(iconSvg)) {
  throw new Error(`Missing SVG source: ${iconSvg}`);
}

const { SVGIcons2SVGFontStream } = require('svgicons2svgfont');

const fontStream = new SVGIcons2SVGFontStream({
  fontName: 'ollama-tracker',
  fontHeight: 1024,
  normalize: true,
  metadata: {
    author: 'Ollama Token Tracker',
    description: 'Single-color llama face icon used in the status bar',
  },
});

const out = fs.createWriteStream(svgFontPath);
fontStream.pipe(out);

const glyphStream = fs.createReadStream(iconSvg);
glyphStream.metadata = {
  name: 'ollama-tracker',
  unicode: ['\uf102'],
};
fontStream.write(glyphStream);
fontStream.end();

out.on('finish', () => {
  const fontSvg = fs.readFileSync(svgFontPath, 'utf8');
  const replaced = fontSvg.replace(/font-family="[^"]+"/, 'font-family="ollama-tracker"');
  fs.writeFileSync(svgFontPath, replaced, 'utf8');

  const ttf = execFileSync('npx', ['svg2ttf', svgFontPath, ttfPath], { stdio: 'inherit' });
  if (ttf) {}

  execFileSync('npx', ['ttf2woff', ttfPath, woffPath], { stdio: 'inherit' });
  console.log(`Generated ${woffPath}`);
});

out.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

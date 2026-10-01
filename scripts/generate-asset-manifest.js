const fs = require('node:fs');
const path = require('node:path');
const buildDir = path.resolve(__dirname, '../build');

// Include every emitted chunk, including dynamically imported modules and
// prediction workers. The offline shell must not depend on CRA's manifest.
function assets(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? assets(file) : /\.(?:js|css)$/.test(entry.name) ? [file] : [];
  });
}
if (!fs.existsSync(path.join(buildDir, 'index.html'))) throw new Error('Run the Vite build first');
const files = { 'index.html': '/index.html' };
for (const file of assets(path.join(buildDir, 'static')).sort()) {
  const relative = path.relative(buildDir, file).split(path.sep).join('/');
  files[relative] = `/${relative}`;
}
fs.writeFileSync(path.join(buildDir, 'asset-manifest.json'), `${JSON.stringify({ files }, null, 2)}\n`);
console.log(`Generated offline asset manifest with ${Object.keys(files).length} files`);

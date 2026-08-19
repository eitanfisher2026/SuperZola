// Precompiles public/app.js (JSX) into public/app.compiled.js (plain JS) so
// the browser never has to run the in-browser Babel transformer. Run this
// before every `firebase deploy --only hosting`. The source file (app.js)
// stays exactly as-is and is what gets edited; only the compiled output
// changes.
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const srcPath = path.join(__dirname, '..', 'public', 'app.js');
const outPath = path.join(__dirname, '..', 'public', 'app.compiled.js');

const source = fs.readFileSync(srcPath, 'utf8');
const result = babel.transformSync(source, {
  presets: ['@babel/preset-react'],
  filename: srcPath,
  compact: false,
});

fs.writeFileSync(outPath, result.code, 'utf8');
console.log('Compiled', srcPath, '->', outPath, '(' + result.code.length + ' bytes)');

import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const publicDir = path.join(rootDir, 'public');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const filesToCopy = [
  'index.html',
  'quiz_matem_tico_calculadora.html',
  'admin.html'
];

for (const file of filesToCopy) {
  const src = path.join(rootDir, file);
  const dest = path.join(publicDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} -> public/${file}`);
  }
}

// Cria _redirects dentro de public para redirecionamentos instantâneos sem loops
const redirectsContent = `/admin /admin.html 200
/painel-admin /admin.html 200
`;
fs.writeFileSync(path.join(publicDir, '_redirects'), redirectsContent, 'utf-8');
console.log('Created public/_redirects');


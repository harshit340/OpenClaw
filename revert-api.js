const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'client', 'src');
const TARGET_URL = 'https://openclaw-j5xo.onrender.com/api/';

function walk(directory) {
  const files = fs.readdirSync(directory);
  for (const file of files) {
    const fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walk(fullPath);
    } else if (fullPath.endsWith('.js') || fullPath.endsWith('.jsx')) {
      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes(TARGET_URL)) {
        content = content.replace(new RegExp(TARGET_URL.replace(/\//g, '\\/'), 'g'), '/api/');
        fs.writeFileSync(fullPath, content, 'utf-8');
        console.log(`Reverted ${fullPath}`);
      }
    }
  }
}

walk(dir);
console.log('API rollback complete.');

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'client', 'src');
const TARGET_URL = 'http://127.0.0.1:8891/api/';

function walk(directory) {
  const files = fs.readdirSync(directory);
  for (const file of files) {
    const fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walk(fullPath);
    } else if (fullPath.endsWith('.js') || fullPath.endsWith('.jsx')) {
      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes('"/api/') || content.includes('`/api/')) {
        content = content.replace(/"\/api\//g, `"${TARGET_URL}`);
        content = content.replace(/`\/api\//g, `\`${TARGET_URL}`);
        fs.writeFileSync(fullPath, content, 'utf-8');
        console.log(`Rewrote local proxy paths for ${path.basename(fullPath)}`);
      }
    }
  }
}

walk(dir);
console.log('Local API routes explicitly mapped.');

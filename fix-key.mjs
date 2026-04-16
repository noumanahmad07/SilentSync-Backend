// Script to fix the private key format in the service account file
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find the service account file
const files = fs.readdirSync(__dirname);
const serviceAccountFile = files.find(f => f.includes('firebase-adminsdk') && f.endsWith('.json'));

if (!serviceAccountFile) {
  console.error('No service account file found!');
  process.exit(1);
}

console.log(`Found service account file: ${serviceAccountFile}`);

// Read and parse
const content = fs.readFileSync(path.join(__dirname, serviceAccountFile), 'utf8');
const parsed = JSON.parse(content);

// Fix the private key - convert literal \n to actual newlines
if (parsed.private_key) {
  const originalKey = parsed.private_key;
  const fixedKey = originalKey.replace(/\\n/g, '\n');
  
  if (originalKey !== fixedKey) {
    parsed.private_key = fixedKey;
    fs.writeFileSync(path.join(__dirname, serviceAccountFile), JSON.stringify(parsed, null, 2));
    console.log('✓ Fixed private key format (converted \\\\n to newlines)');
  } else {
    console.log('Private key already has correct format');
  }
}

console.log('✓ Service account file is ready');

// Test Firebase initialization
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('[Test] Starting Firebase test...');

// Read service account
const files = fs.readdirSync(__dirname);
const saFile = files.find(f => f.includes('firebase-adminsdk') && f.endsWith('.json'));

if (!saFile) {
  console.error('[Test] No service account file found');
  process.exit(1);
}

console.log(`[Test] Found file: ${saFile}`);

const content = JSON.parse(fs.readFileSync(path.join(__dirname, saFile), 'utf8'));
console.log(`[Test] Parsed JSON, has private_key: ${!!content.private_key}`);
console.log(`[Test] Project ID: ${content.project_id}`);
console.log(`[Test] Client email: ${content.client_email}`);

if (content.private_key) {
  console.log(`[Test] Key length: ${content.private_key.length}`);
  console.log(`[Test] Key starts with: ${content.private_key.substring(0, 50)}`);
  console.log(`[Test] Key ends with: ${content.private_key.substring(content.private_key.length - 30)}`);
  console.log(`[Test] Contains \\\\n: ${content.private_key.includes('\\n')}`);
  console.log(`[Test] Contains actual newlines: ${content.private_key.includes('\n')}`);
  
  // Count newlines
  const newlineCount = (content.private_key.match(/\n/g) || []).length;
  console.log(`[Test] Number of newlines: ${newlineCount}`);
}

// Try to initialize
try {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(content),
      projectId: content.project_id,
    });
    console.log('[Test] Firebase initialized successfully!');
  }
} catch (e) {
  console.error('[Test] Firebase init failed:', e.message);
}

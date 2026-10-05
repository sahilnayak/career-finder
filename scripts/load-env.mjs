// load-env.mjs — zero-dependency .env loader. Import for side effect:
//   import './load-env.mjs';
// Populates process.env from the project-root .env for any key not already set
// (so HUNTER_API_KEY / ASSEMBLYAI_API_KEY are visible without dotenv or direnv).
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

try {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      if (/^\s*#/.test(line) || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch { /* ignore */ }

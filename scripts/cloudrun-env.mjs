/**
 * npm run cloudrun:env -- https://your-site.netlify.app[,https://another-address]
 *
 * Writes .env.cloudrun.yaml (never committed, never uploaded) with the settings Cloud Run needs, taken
 * from .env. The service-account key is left out on purpose: on Cloud Run the backend runs as
 * that service account, so no private key is stored. ALLOWED_ORIGIN is set to the address(es) given
 * (the dashboard site), since requests arrive through Netlify from there.
 * Prints setting names only, never values.
 *
 * The parsing and checks are the pure function buildCloudRunEnv (tested without any real .env);
 * the file reading and writing only run when this script is started directly.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

export const LEAVE_OUT = new Set(['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'ALLOWED_ORIGIN', 'PORT', 'K_SERVICE']);
export const REQUIRED = ['FIREBASE_PROJECT_ID', 'BQ_PROJECT_ID', 'DASHBOARD_ACCESS'];

/** "https://a, https://b/" -> ['https://a', 'https://b'], or null when empty or any address is not a plain https origin. */
export function parseOrigins(arg) {
  const origins = String(arg || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return origins.length && origins.every((o) => /^https:\/\/[a-z0-9.-]+$/i.test(o)) ? origins : null;
}

/**
 * From the text of a .env file and the site address argument: `{ yaml, kept, leftOut }`, or `{ error }`.
 * `kept` / `leftOut` are setting names only. Every YAML value is a JSON string (valid YAML), so quotes,
 * braces and commas stay intact.
 */
export function buildCloudRunEnv(envText, originsArg) {
  const origins = parseOrigins(originsArg);
  if (!origins) return { error: 'Give the dashboard site address, e.g.: npm run cloudrun:env -- https://bw-intelligence.netlify.app' };
  const settings = parseEnv(String(envText));
  const missing = REQUIRED.filter((k) => !settings[k]);
  if (missing.length) return { error: `.env is missing required settings: ${missing.join(', ')}` };
  const kept = Object.entries(settings).filter(([k]) => !LEAVE_OUT.has(k));
  kept.push(['ALLOWED_ORIGIN', origins.join(',')]);
  return {
    yaml: `${kept.map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`).join('\n')}\n`,
    kept: kept.map(([k]) => k),
    leftOut: [...LEAVE_OUT].filter((k) => k in settings),
  };
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const file = path.join(root, '.env');
  if (!parseOrigins(process.argv[2])) {
    console.error(buildCloudRunEnv('', process.argv[2]).error);
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error('.env not found in the backend folder.');
    process.exit(1);
  }
  // Read the file itself (not process.env), so a setting also present in this shell is never dropped.
  const out = buildCloudRunEnv(readFileSync(file, 'utf8'), process.argv[2]);
  if (out.error) {
    console.error(out.error);
    process.exit(1);
  }
  writeFileSync(path.join(root, '.env.cloudrun.yaml'), out.yaml);
  console.log(`Wrote .env.cloudrun.yaml with ${out.kept.length} settings: ${out.kept.join(', ')}`);
  console.log(`Left out (not needed on Cloud Run): ${out.leftOut.join(', ') || 'none'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

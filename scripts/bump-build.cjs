#!/usr/bin/env node
/**
 * bump-build.cjs
 *
 * Auto-increments the build number every time `npm run build` runs.
 * Reads the current BUILD_NUMBER out of src/shared/version.ts, bumps
 * it by 1, and rewrites the file -- APP_VERSION (semver) is left
 * untouched since that's something you bump manually for real releases.
 *
 * Wired up via package.json's "prebuild" script, which npm runs
 * automatically before "build" every time.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'shared', 'version.ts');

let content;
try {
  content = fs.readFileSync(FILE, 'utf8');
} catch (e) {
  console.error(`[bump-build] Could not read ${FILE}:`, e.message);
  process.exit(1);
}

const versionMatch = content.match(/export const APP_VERSION\s*=\s*'([^']+)'/);
const buildMatch   = content.match(/export const BUILD_NUMBER\s*=\s*(\d+)/);

const appVersion = versionMatch ? versionMatch[1] : '1.0.0';
const currentBuild = buildMatch ? parseInt(buildMatch[1], 10) : 0;
const nextBuild = currentBuild + 1;

const newContent = [
  "// Keep APP_VERSION in sync with package.json's \"version\" field --",
  '// bump this manually for real releases.',
  `export const APP_VERSION = '${appVersion}';`,
  '',
  '// BUILD_NUMBER auto-increments every time `npm run build` runs --',
  '// see scripts/bump-build.cjs (wired up via package.json\'s "prebuild").',
  '// Do not edit this by hand; it will be overwritten on the next build.',
  `export const BUILD_NUMBER = ${nextBuild};`,
  '',
].join('\n');

fs.writeFileSync(FILE, newContent, 'utf8');
console.log(`[bump-build] BUILD_NUMBER: ${currentBuild} -> ${nextBuild}`);

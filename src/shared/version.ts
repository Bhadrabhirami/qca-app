// Keep APP_VERSION in sync with package.json's "version" field --
// bump this manually for real releases.
export const APP_VERSION = '1.0.0';

// BUILD_NUMBER auto-increments every time `npm run build` runs --
// see scripts/bump-build.cjs (wired up via package.json's "prebuild").
// Do not edit this by hand; it will be overwritten on the next build.
export const BUILD_NUMBER = 589;

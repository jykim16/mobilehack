import { readFileSync, writeFileSync } from 'node:fs';

const launcher = new URL('../node_modules/expo-dev-launcher/', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', launcher), 'utf8'));

if (version === '58.0.20') {
  const toolbar = new URL('ios/SwiftUI/Navigation/DevLauncherToolbar.swift', launcher);
  const source = readFileSync(toolbar, 'utf8');
  const patched = source.replace('      axisBehavior(.verticalPreferred)', '      self');

  if (patched !== source) writeFileSync(toolbar, patched);
}

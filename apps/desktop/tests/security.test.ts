import { describe, expect, it } from 'vitest';
import {
  assertTrustedRendererUrl,
  createTrustedRendererPolicy,
  isAllowedExternalUrl,
  isTrustedRendererUrl,
} from '../electron/security';

const policy = createTrustedRendererPolicy(
  'file:///C:/Program%20Files/MSC/resources/app.asar/dist/renderer/index.html',
  'http://localhost:5173/',
);

describe('trusted renderer policy', () => {
  it.each([
    'http://localhost:5173/',
    'http://localhost:5173/settings?tab=java#download',
    'file:///C:/Program%20Files/MSC/resources/app.asar/dist/renderer/index.html',
    'file:///c:/Program%20Files/MSC/resources/app.asar/dist/renderer/index.html#/settings',
  ])('accepts %s', (url) => {
    expect(isTrustedRendererUrl(url, policy)).toBe(true);
  });

  it.each([
    'https://localhost:5173/',
    'http://127.0.0.1:5173/',
    'http://localhost:5174/',
    'http://user@localhost:5173/',
    'https://evil.example/?next=http://localhost:5173/',
    'file:///C:/Program%20Files/MSC/resources/app.asar/dist/renderer/other.html',
    'file:///C:/Windows/System32/calc.exe',
    'not a URL',
  ])('rejects %s', (url) => {
    expect(isTrustedRendererUrl(url, policy)).toBe(false);
    expect(() => assertTrustedRendererUrl(url, policy)).toThrow(/untrusted renderer/);
  });
});

describe('external URL policy', () => {
  it.each([
    'https://playit.gg/download',
    'https://playit.gg/claim/example',
    'https://adoptium.net/temurin/releases/?version=21',
  ])('allows %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    'http://playit.gg/download',
    'https://playit.gg.evil.example/download',
    'https://user@playit.gg/download',
    'https://github.com/example/example',
    'file:///C:/Windows/System32/calc.exe',
  ])('denies %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });
});

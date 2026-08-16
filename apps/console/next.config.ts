import type { NextConfig } from 'next';

/**
 * The desktop build exports the console to plain files that Electron loads off
 * disk — no Next server in the packaged app. Every route is already static, so
 * this costs nothing; it is opt-in only so `pnpm helm` keeps its dev server.
 */
const isDesktop = process.env.HELM_TARGET === 'desktop';

const config: NextConfig = {
  reactStrictMode: true,
  ...(isDesktop ? { output: 'export' as const, distDir: '.next-desktop' } : {}),
  // @helm/core ships TypeScript source; Next compiles it with the app.
  transpilePackages: ['@helm/core'],
  eslint: { ignoreDuringBuilds: true },
  // @helm/core is ESM TypeScript source: its imports carry .js specifiers, which
  // must resolve back to the .ts files on disk.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  turbopack: {
    resolveAlias: {},
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
  env: {
    NEXT_PUBLIC_BRIDGE_PORT: process.env.HELM_BRIDGE_PORT ?? '8787',
  },
};

export default config;

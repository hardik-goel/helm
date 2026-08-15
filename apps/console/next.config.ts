import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
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

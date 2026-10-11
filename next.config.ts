import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    // Type errors should fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;

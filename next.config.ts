import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mark native/server-only packages as external so they don't get bundled
  serverExternalPackages: ['@google-cloud/documentai', 'sharp', 'pdf-to-img', 'canvas'],

  // Empty turbopack config silences the turbopack/webpack mismatch warning
  // and tells Next.js to use Turbopack without any custom webpack config
  turbopack: {},

  // Allow large file uploads (40MB)
  experimental: {
    serverActions: {
      bodySizeLimit: '40mb',
    },
  },
};

export default nextConfig;

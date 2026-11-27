/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Optional native add-ons pulled in by wallet libraries; not needed in the browser.
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, os: false, path: false };
    return config;
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Limit build workers so a one-off build can run on the demo's small EC2 instance.
  experimental: { cpus: 1 },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "@anthropic-ai/claude-agent-sdk"],
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "@anthropic-ai/claude-agent-sdk", "canvas", "pdfjs-dist"],
  },
};

export default nextConfig;

import type { NextConfig } from "next";

// Local development only: PASHADHARA_API_ORIGIN forwards /api to a separately running API.
// On Vercel the root Services config already routes /api, so leave it unset there.
const api = process.env.PASHADHARA_API_ORIGIN;
const config: NextConfig = {
  devIndicators: false,
  agentRules: false,
  ...(api && { rewrites: async () => [{ source: "/api/:path*", destination: `${api}/api/:path*` }] }),
};
export default config;

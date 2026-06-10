/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // TODO: Content-Security-Policy - Next's inline runtime scripts need
          // nonce/hash plumbing, so a strict CSP is a separate project.
          // frame-ancestors is carved out below because it needs no nonce
          // plumbing - it governs embedding, not scripts.
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Modern equivalent of X-Frame-Options: DENY (kept for older
          // browsers); also covers nested-frame cases XFO doesn't.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

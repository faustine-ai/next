/**
 * Optional `next.config` wrapper. It does one thing: makes the build's commit
 * SHA available to the handler as `FAUSTINE_BUILD_SHA`, taken from the
 * platform's own variable (Vercel, GitHub Actions, Netlify, Cloudflare Pages,
 * Heroku) or from `FAUSTINE_BUILD_SHA` itself. The handler then answers it in
 * `/api/faustine/manifest` and the `x-faustine-build` header, which is how
 * the portal learns which commit a deployment runs (I3). No network at build
 * time, nothing added to the registry.
 */
export function withFaustine<T extends { env?: Record<string, string | undefined> }>(nextConfig: T = {} as T): T {
  const sha =
    process.env.FAUSTINE_BUILD_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.COMMIT_REF ||
    process.env.SOURCE_VERSION ||
    '';
  if (!sha) return nextConfig;
  return { ...nextConfig, env: { ...(nextConfig.env ?? {}), FAUSTINE_BUILD_SHA: sha } };
}

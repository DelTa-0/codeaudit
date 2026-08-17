import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function bool(name: string): boolean {
  const v = (process.env[name] ?? "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "require" || v === "yes";
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  appUrl: process.env.APP_URL ?? "http://localhost:5174",
  apiUrl: process.env.API_URL ?? "http://localhost:4000",
  databaseUrl: required("DATABASE_URL"),
  // Enable TLS to Postgres (e.g. AWS RDS). Within a VPC the pragmatic default
  // is to encrypt without CA pinning; set DATABASE_SSL=require to turn it on.
  databaseSsl: bool("DATABASE_SSL"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6380",
  // Enable TLS to Redis (e.g. ElastiCache in-transit encryption). Auto-on when
  // REDIS_URL uses the rediss:// scheme; REDIS_TLS=true forces it otherwise.
  redisTls: bool("REDIS_TLS") || (process.env.REDIS_URL ?? "").startsWith("rediss://"),
  // Absolute path to the built web bundle the API serves (same-origin SPA).
  // Empty disables static serving (API-only, e.g. local dev with Vite).
  webDistDir: process.env.WEB_DIST_DIR ?? "",
  jwtSecret: required("JWT_SECRET"),
  llm: {
    apiKey: process.env.XAI_API_KEY ?? "",
    baseUrl: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
    model: process.env.XAI_MODEL ?? "openai/gpt-oss-120b",
  },
  github: {
    appId: process.env.GITHUB_APP_ID ?? "",
    // The App's URL slug, used to build the install link. Not derivable from
    // the App ID, and not the same as the App's display name — read it out of
    // the address bar at github.com/settings/apps/<slug>. Hardcoding it is how
    // the install link came to point at a slug that 404s.
    slug: process.env.GITHUB_APP_SLUG ?? "",
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? "",
    // PEM contents supplied directly (e.g. from AWS Secrets Manager as an env
    // var). Takes precedence over the file path when set. Literal "\n" escapes
    // are normalized to real newlines so the key survives env-var transport.
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    clientId: process.env.GITHUB_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    pricePro: process.env.STRIPE_PRICE_PRO ?? "",
    priceTeam: process.env.STRIPE_PRICE_TEAM ?? "",
  },
};

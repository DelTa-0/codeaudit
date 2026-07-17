import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  appUrl: process.env.APP_URL ?? "http://localhost:5173",
  apiUrl: process.env.API_URL ?? "http://localhost:4000",
  databaseUrl: required("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6380",
  jwtSecret: required("JWT_SECRET"),
  llm: {
    apiKey: process.env.XAI_API_KEY ?? "",
    baseUrl: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
    model: process.env.XAI_MODEL ?? "grok-3-mini",
  },
  github: {
    appId: process.env.GITHUB_APP_ID ?? "",
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? "",
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

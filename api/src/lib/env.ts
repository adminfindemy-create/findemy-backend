import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('8080'),
  MOCK: z.string().default('0'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  // Key for per-class attendance codes (lib/attendance-code.ts). Optional: when unset the codes are
  // keyed off JWT_PRIVATE_KEY, so every environment works without new config.
  ATTENDANCE_CODE_SECRET: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // 100ms (online live classes) — optional; absent → mock token / no live A/V.
  HMS_ACCESS_KEY: z.string().optional(),
  HMS_SECRET: z.string().optional(),
  HMS_MANAGEMENT_TOKEN: z.string().optional(),
  HMS_TEMPLATE_ID: z.string().optional(),
  HMS_WEBHOOK_SECRET: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  GOOGLE_GEOCODING_KEY: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  APPLE_STUDENT_BUNDLE_ID: z.string().optional(),
  APPLE_ADMIN_BUNDLE_ID: z.string().optional(),
  GOOGLE_STUDENT_IOS_CLIENT_ID: z.string().optional(),
  GOOGLE_STUDENT_ANDROID_CLIENT_ID: z.string().optional(),
  GOOGLE_ADMIN_IOS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADMIN_ANDROID_CLIENT_ID: z.string().optional(),
  // ---- Ops Console (platform-operator admin) ----
  // Google Workspace web OAuth client id for the Ops Console, and the Findemy Workspace
  // hosted-domain that admin logins must carry in their `hd` claim.
  GOOGLE_OPS_WEB_CLIENT_ID: z.string().optional(),
  FINDEMY_ADMIN_DOMAIN: z.string().default('findemy.com'),
  // Browser origin allowed to call /admin (CORS). Defaults to the Vite dev server.
  OPS_CONSOLE_ORIGIN: z.string().default('http://localhost:5174'),
  // Public marketing/discovery web app origin allowed to call /public/* (CORS).
  // Defaults to the Next.js dev server.
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
});

export const env = envSchema.parse(process.env);

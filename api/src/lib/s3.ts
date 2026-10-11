import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

// AWS S3 storage config. Credentials come from the SDK default chain (ECS task role in prod,
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or ~/.aws locally) — no keys live in our env.
//   * S3_BUCKET         — public media, fronted by CloudFront (S3_PUBLIC_BASE_URL).
//   * S3_PRIVATE_BUCKET — private files (class notes); never served publicly. Falls back to S3_BUCKET.
// With S3_BUCKET unset, callers fall back to local disk (dev).

let client: S3Client | null = null;

export function s3Client(): S3Client | null {
  if (!env.S3_BUCKET) return null;
  client ??= new S3Client({ region: env.S3_REGION });
  return client;
}

export function publicBucket(): string {
  return env.S3_BUCKET!;
}

export function privateBucket(): string {
  return env.S3_PRIVATE_BUCKET ?? env.S3_BUCKET!;
}

/** Permanent public URL for an object in the public bucket. */
export function publicUrlFor(key: string): string {
  const base = env.S3_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
  return `${base}/${key}`;
}

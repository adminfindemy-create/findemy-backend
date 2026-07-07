import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env.js';
import { AppError } from './app-error.js';
import { newId } from './id.js';

// Photo/video media storage. Uses Cloudflare R2 (or, later, GCS) when configured; otherwise
// falls back to local disk served by GET /uploads/* — so media works in dev without cloud creds.

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export type MediaType = 'photo' | 'video';
export const UPLOAD_DIR = path.resolve('uploads');

function r2Client() {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
}

// Store an uploaded file and return its public URL + media type. `baseUrl` (e.g.
// "http://localhost:8080") is used to build the URL for the local-disk fallback.
export async function storeMedia(args: {
  keyPrefix: string;
  buffer: Buffer;
  mimeType: string;
  baseUrl: string;
}): Promise<{ url: string; type: MediaType }> {
  const ext = EXT_BY_MIME[args.mimeType];
  if (!ext) {
    throw new AppError('VALIDATION', 400, 'Unsupported media type. Upload an image (png/jpg/webp/heic) or video (mp4/mov/webm).');
  }
  const type: MediaType = args.mimeType.startsWith('video/') ? 'video' : 'photo';
  const key = `${args.keyPrefix}/${newId()}.${ext}`;

  const s3 = r2Client();
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: key, Body: args.buffer, ContentType: args.mimeType }));
    return { url: `https://${env.R2_BUCKET}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`, type };
  }

  // Local-disk fallback.
  const dest = path.join(UPLOAD_DIR, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, args.buffer);
  const base = args.baseUrl.replace(/\/$/, '');
  return { url: `${base}/uploads/${key}`, type };
}

// Read a locally-stored media file for GET /uploads/*. Guards against path traversal.
export async function readLocalMedia(relPath: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const clean = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(UPLOAD_DIR, clean);
  if (!full.startsWith(UPLOAD_DIR)) return null; // traversal attempt
  try {
    const buffer = await fs.readFile(full);
    const ext = path.extname(full).slice(1).toLowerCase();
    return { buffer, contentType: CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

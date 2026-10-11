import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env.js';
import { AppError } from './app-error.js';
import { newId } from './id.js';

// Photo/video media storage. Uses Cloudflare R2 (or, later, GCS) when configured; otherwise
// falls back to local disk served by GET /uploads/* — so media works in dev without cloud creds.
//
// TWO storage worlds live here, deliberately kept apart:
//   * PUBLIC  — storeMedia() → a permanently public URL (bucket URL, or /uploads/* in dev).
//   * PRIVATE — storePrivateFile() → an opaque storage key that is never publicly served.
//               Class-note attachments use this so the entitlement check on
//               GET /me/notes/:fileId/file is the only way in.

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

// Class-note attachments: a photographed whiteboard or a scanned/exported PDF. Deliberately a
// SEPARATE allow-list from EXT_BY_MIME — storeMedia() classifies everything it accepts as
// photo|video, which a PDF is not. Audio (practice tracks) is deferred: it needs a player UI.
const NOTE_EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

export type MediaType = 'photo' | 'video';
export const UPLOAD_DIR = path.resolve('uploads');
// A sibling of UPLOAD_DIR rather than a subdirectory: GET /uploads/* resolves inside UPLOAD_DIR
// and refuses to traverse out, so private objects are structurally unreachable from it.
export const PRIVATE_DIR = path.resolve('private-uploads');

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

export const NOTE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — matches the global multipart cap.

/** Human-readable size, used in the over-limit rejection message. */
function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Store a private (never publicly served) object and return its storage key. Same key shape on
 * R2 and local disk, so one read path serves both. Rejects unsupported types and oversize files
 * with a message that NAMES the real limit — a silent 413 is how teachers abandon a feature.
 */
export async function storePrivateFile(args: {
  keyPrefix: string;
  buffer: Buffer;
  mimeType: string;
  maxBytes?: number;
}): Promise<{ storageKey: string; sizeBytes: number }> {
  const ext = NOTE_EXT_BY_MIME[args.mimeType];
  if (!ext) {
    throw new AppError('VALIDATION', 400, 'Notes take a PDF or a photo (png/jpg/webp/heic).');
  }
  const maxBytes = args.maxBytes ?? NOTE_MAX_BYTES;
  if (args.buffer.byteLength > maxBytes) {
    throw new AppError(
      'VALIDATION',
      400,
      `That file is ${mb(args.buffer.byteLength)}. Notes must be under ${mb(maxBytes)} — try scanning at a lower quality.`,
    );
  }

  const storageKey = `${args.keyPrefix}/${newId()}.${ext}`;
  const s3 = r2Client();
  if (s3) {
    await s3.send(
      new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: storageKey, Body: args.buffer, ContentType: args.mimeType }),
    );
    return { storageKey, sizeBytes: args.buffer.byteLength };
  }

  const dest = privatePathFor(storageKey);
  if (!dest) throw new AppError('VALIDATION', 400, 'Invalid file key');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, args.buffer);
  return { storageKey, sizeBytes: args.buffer.byteLength };
}

/** Resolve a storage key under PRIVATE_DIR, refusing traversal. Null = rejected. */
function privatePathFor(storageKey: string): string | null {
  const clean = path.normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(PRIVATE_DIR, clean);
  return full.startsWith(PRIVATE_DIR + path.sep) ? full : null;
}

/**
 * Read a private object by storage key. Callers MUST have run their entitlement check first —
 * this function knows nothing about who is asking.
 */
export async function readPrivateFile(
  storageKey: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const ext = path.extname(storageKey).slice(1).toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';

  const s3 = r2Client();
  if (s3) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: env.R2_BUCKET!, Key: storageKey }));
      if (!res.Body) return null;
      const bytes = await res.Body.transformToByteArray();
      return { buffer: Buffer.from(bytes), contentType };
    } catch {
      return null;
    }
  }

  const full = privatePathFor(storageKey);
  if (!full) return null;
  try {
    return { buffer: await fs.readFile(full), contentType };
  } catch {
    return null;
  }
}

/** Best-effort delete of a private object. A missing object is not an error. */
export async function deletePrivateFile(storageKey: string): Promise<void> {
  const s3 = r2Client();
  if (s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET!, Key: storageKey })).catch(() => {});
    return;
  }
  const full = privatePathFor(storageKey);
  if (!full) return;
  await fs.unlink(full).catch(() => {});
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

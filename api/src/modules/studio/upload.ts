import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, publicBucket, publicUrlFor } from '../../lib/s3.js';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';

export async function uploadAcademyImage(
  academyId: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  const s3 = s3Client();
  if (!s3) {
    throw new AppError('CONFIG', 400, 'Media upload is not configured. Set S3_BUCKET in environment variables.');
  }

  // S1.1: academy media gallery accepts photos AND videos (≤10 total).
  const EXT_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  };
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) {
    throw new AppError('VALIDATION', 400, 'Unsupported media type. Upload an image (png/jpg/webp) or video (mp4/mov/webm).');
  }
  const key = `academies/${academyId}/${newId()}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: publicBucket(),
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
    }),
  );

  return publicUrlFor(key);
}

export async function addAcademyImage(academyId: string, imageUrl: string) {
  const academy = await prisma.academy.findUnique({ where: { id: academyId }, select: { images: true } });
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  if (academy.images.length >= 10) throw new AppError('VALIDATION', 400, 'Maximum 10 images allowed');

  return prisma.academy.update({
    where: { id: academyId },
    data: { images: { push: imageUrl } },
    select: { images: true },
  });
}

export async function removeAcademyImage(academyId: string, imageUrl: string) {
  const academy = await prisma.academy.findUnique({ where: { id: academyId }, select: { images: true } });
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');

  return prisma.academy.update({
    where: { id: academyId },
    data: { images: academy.images.filter((u) => u !== imageUrl) },
    select: { images: true },
  });
}

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, privateBucket } from './s3.js';

// KYC documents (PAN / Aadhaar image / business docs) live in the PRIVATE bucket. The DB column
// holds the storage key; every response that exposes one swaps it for a short-lived presigned
// URL, so a leaked URL stops working within minutes and the bucket is never public.
//
// Keys are brand-scoped (`kyc/<groupId>/…`). A client submits keys back when saving an entity, so
// writes MUST pass assertKycKeysOwnedBy — otherwise brand A could save brand B's key and be
// handed a signed URL for B's Aadhaar.

const KYC_URL_TTL_SECONDS = 300;

export function kycKeyPrefix(groupId: string): string {
  return `kyc/${groupId}/`;
}

/** True when `key` is a KYC storage key belonging to this brand (and not a traversal trick). */
export function isKycKeyOwnedBy(key: string, groupId: string): boolean {
  return key.startsWith(kycKeyPrefix(groupId)) && !key.includes('..');
}

async function signKey(key: string): Promise<string> {
  const s3 = s3Client();
  // Local-disk dev: nothing to sign. The raw key is returned; viewing documents needs S3.
  if (!s3) return key;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: privateBucket(), Key: key }), {
    expiresIn: KYC_URL_TTL_SECONDS,
  });
}

type KycFields = {
  panImageUrl: string | null;
  aadhaarImageUrl: string | null;
  businessDocUrls: string[];
};

/** Copy of a financial entity with its KYC document keys replaced by presigned URLs. */
export async function signKycEntity<T extends KycFields>(entity: T): Promise<T> {
  const [panImageUrl, aadhaarImageUrl, businessDocUrls] = await Promise.all([
    entity.panImageUrl ? signKey(entity.panImageUrl) : null,
    entity.aadhaarImageUrl ? signKey(entity.aadhaarImageUrl) : null,
    Promise.all((entity.businessDocUrls ?? []).map(signKey)),
  ]);
  return { ...entity, panImageUrl, aadhaarImageUrl, businessDocUrls };
}

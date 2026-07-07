export type CursorPayload = { id: string; ts: string };

export const encodeCursor = (p: CursorPayload): string =>
  Buffer.from(JSON.stringify(p)).toString('base64url');

export const decodeCursor = (c: string): CursorPayload | null => {
  try {
    const parsed = JSON.parse(Buffer.from(c, 'base64url').toString('utf-8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.id === 'string' &&
      typeof parsed.ts === 'string'
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
};

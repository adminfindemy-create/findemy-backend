import { Expo } from 'expo-server-sdk';
import { env } from '../../lib/env.js';
import * as repo from './repo.js';

let expo: Expo | null = null;
function getExpo() {
  if (!expo) expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN });
  return expo;
}

export async function registerPushToken({
  subjectId,
  subjectRole,
  token,
  platform,
}: {
  subjectId: string;
  subjectRole: 'student' | 'academy';
  token: string;
  platform: 'ios' | 'android';
}) {
  if (!Expo.isExpoPushToken(token)) {
    return { ok: false, error: 'Invalid push token' };
  }
  await repo.upsertPushToken({ subjectId, subjectRole, token, platform });
  return { ok: true };
}

export async function unregisterPushToken(token: string) {
  await repo.deletePushToken(token);
  return { ok: true };
}

export async function sendPushNotifications({
  subjectId,
  subjectRole,
  title,
  body,
  data,
}: {
  subjectId: string;
  subjectRole: 'student' | 'academy';
  title: string;
  body: string;
  data?: Record<string, unknown>;
}) {
  if (!env.EXPO_ACCESS_TOKEN) return { sent: 0 };

  // Academy callers pass the Academy id, but tokens register under the AcademyAccount id.
  // Resolve so academy pushes actually deliver (fixes the broken academy-notification path).
  let resolvedSubjectId = subjectId;
  if (subjectRole === 'academy') {
    const accountId = await repo.resolveAcademyAccountId(subjectId);
    if (accountId) resolvedSubjectId = accountId;
  }

  const tokens = await repo.findPushTokens(resolvedSubjectId, subjectRole);
  const expo = getExpo();
  const messages = tokens
    .map((t) => ({
      to: t.token,
      sound: 'default',
      title,
      body,
      data: data ?? {},
    }))
    .filter((m): m is any => Expo.isExpoPushToken(m.to));

  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      sent += receipts.length;
    } catch {
      // ignore batch failures
    }
  }
  return { sent };
}

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
  subjectRole: 'student' | 'academy' | 'staff';
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

  // Academy callers pass an Academy id — which is a BRANCH — but tokens register under the
  // login's id, and a brand can hold several logins. Fan out to every OWNER in the branch's
  // group plus the STAFF whose branch scope contains this branch, so a push can't land on one
  // owner and miss the other, and can't reach a manager at a branch they have no access to.
  let recipients: repo.PushRecipient[] = [{ id: subjectId, subjectRole: 'academy' }];
  let outTitle = title;
  let outBody = body;
  let outData: Record<string, unknown> = data ?? {};

  if (subjectRole === 'academy') {
    const [resolved, branch] = await Promise.all([
      repo.resolveAcademyRecipients(subjectId),
      repo.findBranchLabel(subjectId),
    ]);
    // An unresolvable branch would otherwise fan out to nobody; fall back to treating the
    // caller's id as an account id, which is what a single-branch academy used to do.
    recipients = resolved.length > 0 ? resolved : [{ id: subjectId, subjectRole: 'academy' }];

    if (branch) {
      // Name the branch, and carry `branch_id` so tapping the notification can switch the
      // app's active branch to the one the event actually happened at.
      const label = branch.branchLabel ?? branch.name;
      outBody = `${body} · ${label}`;
      outData = { ...outData, branch_id: branch.id, group_id: branch.groupId };
    }
  }

  const tokens =
    subjectRole === 'academy'
      ? await repo.findPushTokensForRecipients(recipients)
      : await repo.findPushTokensForSubjects([subjectId], subjectRole);
  const expo = getExpo();
  const messages = tokens
    .map((t) => ({
      to: t.token,
      sound: 'default',
      title: outTitle,
      body: outBody,
      data: outData,
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

// Broadcast to every device registered under the given subject roles (segment push). Returns the
// targeted device/subject counts alongside how many actually dispatched (0 when EXPO_ACCESS_TOKEN
// is unset — dev/MOCK — so the audience is still reported even though nothing is sent).
export async function sendBroadcast({
  roles,
  title,
  body,
  data,
}: {
  roles: ('student' | 'academy')[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
}) {
  const tokens = await repo.findTokensForRoles(roles);
  const subjects = new Set(tokens.map((t) => t.subjectId)).size;

  let sent = 0;
  if (env.EXPO_ACCESS_TOKEN && tokens.length > 0) {
    const expo = getExpo();
    const messages = tokens
      .map((t) => ({ to: t.token, sound: 'default', title, body, data: data ?? {} }))
      .filter((m): m is any => Expo.isExpoPushToken(m.to));
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const receipts = await expo.sendPushNotificationsAsync(chunk);
        sent += receipts.length;
      } catch {
        // ignore batch failures
      }
    }
  }
  return { recipients: tokens.length, subjects, sent };
}

import { prisma } from '../../lib/prisma.js';

export async function getSettings(accountId: string) {
  const settings = await prisma.academySettings.findUnique({ where: { accountId } });
  return {
    notifications: {
      new_trial_alerts: settings?.notificationsNewTrial ?? true,
      review_alerts: settings?.notificationsReview ?? true,
    },
    privacy: {
      show_phone: settings?.privacyShowPhone ?? false,
    },
  };
}

export async function updateSettings(accountId: string, data: Record<string, unknown>) {
  await prisma.academySettings.upsert({
    where: { accountId },
    create: { accountId, ...(data as any) },
    update: data,
  });
  return { settings: await getSettings(accountId) };
}

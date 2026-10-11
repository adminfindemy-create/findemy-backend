import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';
import { writeStaffAudit } from '../../lib/audit-actor.js';

const RoleEnum = z.enum(['manager', 'teacher']);

// Name, phone, role, branches. NOTHING else — and specifically no `coach_id`: a teacher's
// teaching profile is created for them by `inviteStaff`, so the owner is never asked to link
// two rows that describe the same person.
const InviteSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  role: RoleEnum,
  branch_ids: z.array(z.string().min(1)).min(1),
});

export const staffRoutes: FastifyPluginAsync = async (app) => {
  // `staff.view` is granted to managers so they can SEE the team; every write below is
  // `staff.manage`, which is owner-only.
  app.get('/studio/staff', { preHandler: app.requireAuth('academy', 'staff.view') }, async (req) => {
    return service.listStaff(req.user.group_id!);
  });

  app.get('/studio/staff/roles', { preHandler: app.requireAuth('academy', 'staff.view') }, async () => {
    return service.assignableRoles();
  });

  app.get('/studio/staff/:id', { preHandler: app.requireAuth('academy', 'staff.view') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getStaff(id, req.user.group_id!);
  });

  app.post('/studio/staff', { preHandler: app.requireAuth('academy', 'staff.manage') }, async (req) => {
    const body = InviteSchema.parse(req.body);
    const result = await service.inviteStaff(req.user.group_id!, req.user.id, body);
    await writeStaffAudit(req, {
      action: 'staff.invite',
      targetType: 'StaffAccount',
      targetId: result.staff.id,
      after: { name: body.name, role: body.role, branch_ids: body.branch_ids },
    });
    return result;
  });

  app.put('/studio/staff/:id', { preHandler: app.requireAuth('academy', 'staff.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = InviteSchema.parse(req.body);
    const before = await service.getStaff(id, req.user.group_id!);
    const result = await service.updateStaff(id, req.user.group_id!, body);
    await writeStaffAudit(req, {
      action: 'staff.update',
      targetType: 'StaffAccount',
      targetId: id,
      before: before.staff,
      after: result.staff,
    });
    return result;
  });

  // DELETE is a DEACTIVATION, never a row removal: a staff id is referenced from four bare
  // `String` columns with no FK (class notes, trial/attendance marking, session cancellation)
  // plus the audit log, and all of those need the row to survive to stay resolvable.
  app.delete('/studio/staff/:id', { preHandler: app.requireAuth('academy', 'staff.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const before = await service.getStaff(id, req.user.group_id!);
    const result = await service.deactivateStaff(id, req.user.group_id!);
    await writeStaffAudit(req, {
      action: 'staff.deactivate',
      targetType: 'StaffAccount',
      targetId: id,
      before: before.staff,
    });
    return result;
  });

  app.post('/studio/staff/:id/reactivate', { preHandler: app.requireAuth('academy', 'staff.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const result = await service.reactivateStaff(id, req.user.group_id!);
    await writeStaffAudit(req, {
      action: 'staff.reactivate',
      targetType: 'StaffAccount',
      targetId: id,
    });
    return result;
  });
};

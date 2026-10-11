import { AppError } from '../../lib/app-error.js';
import * as repo from './repo.js';
import { toBatchWire, toProgramWire } from './wire.js';

export async function getProgramById(id: string, academyId?: string) {
  const program = await repo.findProgramById(id, academyId);
  if (!program) throw new AppError('NOT_FOUND', 404, 'Program not found');

  // A program with no active batch at the requested branch is not offered there — the same
  // derived-availability rule the branch page applies (plan §1.1). Surfacing it anyway would
  // let a learner open, and try to book, a program this location does not teach.
  if (academyId && program.batches.length === 0) {
    throw new AppError('NOT_FOUND', 404, 'Program not offered at this branch');
  }

  const batchesWire = program.batches.map(toBatchWire);

  // The branch this read is scoped to. Explicit when `academy_id` was passed; otherwise
  // inferred from the batches, which is unambiguous whenever they all sit at one branch.
  const branch =
    program.batches.find((b) => b.academyId === academyId)?.academy ??
    program.batches[0]?.academy ??
    null;

  return {
    program: toProgramWire(program, batchesWire),
    group: {
      id: program.group.id,
      name: program.group.name,
      category: program.group.category,
    },
    academy: branch
      ? {
          id: branch.id,
          name: branch.name,
          branch_label: branch.branchLabel,
          category: branch.category,
          address: branch.address,
          verified: branch.verified,
          rating: branch.rating,
          rating_count: branch.ratingCount,
          images: branch.images,
        }
      : null,
  };
}

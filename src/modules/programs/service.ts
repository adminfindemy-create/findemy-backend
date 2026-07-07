import { AppError } from '../../lib/app-error.js';
import * as repo from './repo.js';
import { toBatchWire, toProgramWire } from './wire.js';

export async function getProgramById(id: string) {
  const program = await repo.findProgramById(id);
  if (!program) throw new AppError('NOT_FOUND', 404, 'Program not found');

  const batchesWire = program.batches.map(toBatchWire);

  return {
    program: toProgramWire(program, batchesWire),
    academy: {
      id: program.academy.id,
      name: program.academy.name,
      category: program.academy.category,
      address: program.academy.address,
      verified: program.academy.verified,
      rating: program.academy.rating,
      rating_count: program.academy.ratingCount,
      images: program.academy.images,
    },
  };
}

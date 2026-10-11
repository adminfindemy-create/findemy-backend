import { releaseMaturedReserve } from '../modules/settlement/service.js';

// S7: release reserve tranches whose 60-day hold has matured back to the academy.
export async function releaseMaturedReserves() {
  const released = await releaseMaturedReserve(new Date());
  return { released };
}

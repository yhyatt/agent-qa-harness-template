import { aggregateRunReport } from './journeys/helpers.js';

const TARGET = process.env.TEST_TARGET_URL ?? 'http://localhost:3000';

export default async function globalTeardown(): Promise<void> {
  await aggregateRunReport(TARGET);
}

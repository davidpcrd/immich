import { JobRepository } from 'src/repositories/job.repository';
import { RepositoryInterface } from 'src/types';
import { Mocked, vitest } from 'vitest';

export const newJobRepositoryMock = (): Mocked<RepositoryInterface<JobRepository>> => {
  return {
    setup: vitest.fn(),
    startRunners: vitest.fn(),
    run: vitest.fn(),
    setConcurrency: vitest.fn(),
    queue: vitest.fn().mockImplementation(() => Promise.resolve()),
    queueAll: vitest.fn().mockImplementation(() => Promise.resolve()),
    getJobCounts: vitest.fn(),
    clear: vitest.fn(),
  };
};

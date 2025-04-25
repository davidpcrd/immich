import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { ClassConstructor } from 'class-transformer';
import { makeWorkerUtils, run, Runner, TaskSpec, WorkerUtils } from 'graphile-worker';
import { Kysely } from 'kysely';
import { DateTime, Duration } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import pg, { PoolConfig } from 'pg';
import { DB } from 'src/db';
import { GenerateSql, JobConfig } from 'src/decorators';
import { JobName, JobStatus, MetadataKey, QueueName } from 'src/enum';
import { ConfigRepository } from 'src/repositories/config.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { JobCounts, JobItem, JobOf } from 'src/types';
import { asPostgresConnectionConfig } from 'src/utils/database';
import { getKeyByValue, getMethodNames, ImmichStartupError } from 'src/utils/misc';

type JobMapItem = {
  jobName: JobName;
  queueName: QueueName;
  handler: (job: JobOf<any>) => Promise<JobStatus>;
  label: string;
};

@Injectable()
export class JobRepository {
  private handlers: Partial<Record<JobName, JobMapItem>> = {};

  private pool?: pg.Pool;
  private workerUtils?: WorkerUtils;
  private runners: Record<string, Runner> = {};

  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
    private moduleRef: ModuleRef,
    private eventRepository: EventRepository,
    private configRepository: ConfigRepository,
  ) {
    this.logger.setContext(JobRepository.name);
  }

  async setup(services: ClassConstructor<unknown>[]) {
    const reflector = this.moduleRef.get(Reflector, { strict: false });

    for (const service of services) {
      const instance = this.moduleRef.get<any>(service);
      for (const methodName of getMethodNames(instance)) {
        const handler = instance[methodName];
        const config = reflector.get<JobConfig>(MetadataKey.JOB_CONFIG, handler);
        if (!config) {
          continue;
        }

        const { name: jobName, queue: queueName } = config;
        const label = `${service.name}.${handler.name}`;

        // one handler per job
        if (this.handlers[jobName]) {
          const jobKey = getKeyByValue(JobName, jobName);
          const errorMessage = `Failed to add job handler for ${label}`;
          this.logger.error(
            `${errorMessage}. JobName.${jobKey} is already handled by ${this.handlers[jobName].label}.`,
          );
          throw new ImmichStartupError(errorMessage);
        }

        this.handlers[jobName] = {
          label,
          jobName,
          queueName,
          handler: handler.bind(instance),
        };

        this.logger.verbose(`Added job handler: ${jobName} => ${label}`);
      }
    }

    const { database } = this.configRepository.getEnv();
    const pool = new pg.Pool({
      ...asPostgresConnectionConfig(database.config),
      max: 100,
    } as PoolConfig);

    // todo: remove debug info
    setInterval(() => {
      this.logger.log(`connections:
        total: ${pool.totalCount}
        idle: ${pool.idleCount}
        waiting: ${pool.waitingCount}
        expired: ${pool.expiredCount}`);
    }, 5000);

    pool.on('connect', (client) => {
      client.setMaxListeners(200);
    });

    this.pool = pool;

    this.workerUtils = await makeWorkerUtils({ pgPool: pool });
  }

  async startRunners(): Promise<void> {
    for (const queueName of new Set(Object.values(QueueName))) {
      await this.startRunner(queueName);
    }
  }

  async startRunner(queueName: QueueName, concurrency?: number): Promise<void> {
    this.runners[queueName] = await run({
      concurrency,
      taskList: {
        [queueName]: async (payload: unknown): Promise<void> => {
          this.logger.log(`Job ${queueName} started with payload: ${JSON.stringify(payload)}`);
          await this.eventRepository.emit('job.start', queueName, payload as JobItem);
        },
      },
      pgPool: this.pool,
    });
  }

  // todo: we should consolidate queue and job names and have queues be
  // homogenous.
  private getQueueName(name: JobName) {
    return (this.handlers[name] as JobMapItem).queueName;
  }

  async run({ name, data }: JobItem): Promise<JobStatus> {
    const item = this.handlers[name as JobName];
    if (!item) {
      this.logger.warn(`Skipping unknown job: "${name}"`);
      return JobStatus.SKIPPED;
    }

    return item.handler(data);
  }

  @GenerateSql({ params: [] })
  async queue(item: JobItem): Promise<void> {
    const opts = this.getJobOptions(item);

    this.logger.log(`Queueing job: ${this.getQueueName(item.name)}, data: ${JSON.stringify(item)}`);
    await this.workerUtils!.addJob(this.getQueueName(item.name), item, opts);
  }

  @GenerateSql({ params: [] })
  async queueAll(items: JobItem[]): Promise<void> {
    for (const item of items) {
      await this.queue(item);
    }
  }

  async clear(name: QueueName): Promise<void> {
    await this.db
      .deleteFrom('graphile_worker._private_jobs')
      .where(({ eb, selectFrom }) =>
        eb('task_id', 'in', selectFrom('graphile_worker._private_tasks').select('id').where('identifier', '=', name)),
      )
      .execute();

    const workers = await this.db
      .selectFrom('graphile_worker.jobs')
      .select('locked_by')
      .where('locked_by', 'is not', null)
      .distinct()
      .execute();

    // Potentially dangerous? It helps if jobs get stuck active though. The
    // documentation says that stuck jobs will be unlocked automatically after 4
    // hours. Though, it can be strange to click "clear" in the UI and see
    // nothing happen. Especially as the UI is binary, such that new jobs cannot
    // usually be scheduled unless both active and waiting are zero.
    await this.workerUtils!.forceUnlockWorkers(workers.map((worker) => worker.locked_by!));
  }

  @GenerateSql({ params: [] })
  async getJobCounts(name: QueueName): Promise<JobCounts> {
    // select
    //   count(*) filter (where locked_by is not null)              as active,
    //   count(*) filter (where locked_by is null and run_at<=now()) as pending,
    //   count(*) filter (where locked_by is null and run_at>now())  as scheduled
    // from graphile_worker.jobs;

    const active: { count: number } | undefined = await this.db
      .selectFrom('graphile_worker.jobs')
      .select(this.db.fn.countAll<number>().as('count'))
      .where('task_identifier', '=', name)
      .where('locked_by', 'is not', null)
      .executeTakeFirst();

    const pending: { count: number } | undefined = await this.db
      .selectFrom('graphile_worker.jobs')
      .select(this.db.fn.countAll<number>().as('count'))
      .where('task_identifier', '=', name)
      .where('locked_by', 'is', null)
      .where('run_at', '<=', new Date())
      .executeTakeFirst();

    if (!active || !pending) {
      this.logger.error(`Failed to get job counts for queue: ${name}`);
      return <JobCounts>{
        active: 0,
        failed: 0,
        waiting: 0,
      };
    }

    return <JobCounts>{
      active: active.count,
      failed: 0,
      waiting: pending.count,
    };
  }

  async setConcurrency(queueName: QueueName, concurrency: number): Promise<void> {
    const runner = this.runners[queueName];
    if (runner) {
      await runner.stop();
    }
    await this.startRunner(queueName, concurrency);
  }

  getJobOptions(item: JobItem): TaskSpec | undefined {
    switch (item.name) {
      case JobName.NOTIFY_ALBUM_UPDATE: {
        let runAt: Date | undefined;
        if (item.data?.delay) {
          runAt = DateTime.now().plus(Duration.fromMillis(item.data.delay)).toJSDate();
        }
        return { jobKey: item.data.id, runAt };
      }
      case JobName.STORAGE_TEMPLATE_MIGRATION_SINGLE: {
        return { jobKey: QueueName.STORAGE_TEMPLATE_MIGRATION };
      }
      case JobName.GENERATE_PERSON_THUMBNAIL: {
        return { priority: 1 };
      }
      case JobName.QUEUE_FACIAL_RECOGNITION: {
        return { jobKey: JobName.QUEUE_FACIAL_RECOGNITION };
      }
    }
  }
}

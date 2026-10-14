import type { RunRecord, RunStore } from '../../cron-runs.js';
import type { OraclePoolManager } from '../oracle-pool.js';

export class OracleCronStore implements RunStore {
  private poolManager: OraclePoolManager;
  private cap: number;

  constructor(poolManager: OraclePoolManager, cap: number = 500) {
    this.poolManager = poolManager;
    this.cap = Math.max(1, cap);
  }

  public async list(limit: number): Promise<RunRecord[]> {
    return this.poolManager.withConnection(async (conn) => {
      const fetchLimit = Math.max(1, Math.min(limit, this.cap));
      const result = await conn.execute(
        `SELECT run_id, job_id, name, command, started_at_epoch, finished_at_epoch,
                exit_code, timed_out, latency_ms, output
         FROM olp_cron_runs
         ORDER BY started_at_epoch DESC
         FETCH FIRST :lim ROWS ONLY`,
        { lim: fetchLimit }
      );

      if (!result.rows || !Array.isArray(result.rows)) {
        return [];
      }

      return (result.rows as unknown[][]).map((row) => {
        const [id, jobId, name, command, startedAt, finishedAt, exitCode, timedOut, latencyMs, output] = row;
        return {
          id: String(id),
          jobId: String(jobId),
          name: String(name),
          command: String(command),
          startedAt: Number(startedAt),
          finishedAt: Number(finishedAt),
          exitCode: exitCode !== null && exitCode !== undefined ? Number(exitCode) : null,
          timedOut: Boolean(timedOut),
          latencyMs: Number(latencyMs),
          output: output ? String(output) : ''
        };
      });
    });
  }

  public async append(run: RunRecord): Promise<void> {
    return this.poolManager.withConnection(async (conn) => {
      await conn.execute(
        `MERGE INTO olp_cron_runs dst
         USING (SELECT :id AS run_id FROM dual) src
         ON (dst.run_id = src.run_id)
         WHEN MATCHED THEN
           UPDATE SET
             job_id = :jobId,
             name = :name,
             command = :command,
             started_at_epoch = :startedAt,
             finished_at_epoch = :finishedAt,
             exit_code = :exitCode,
             timed_out = :timedOut,
             latency_ms = :latencyMs,
             output = :output
         WHEN NOT MATCHED THEN
           INSERT (
             run_id, job_id, name, command, started_at_epoch, finished_at_epoch,
             exit_code, timed_out, latency_ms, output
           ) VALUES (
             src.run_id, :jobId, :name, :command, :startedAt, :finishedAt,
             :exitCode, :timedOut, :latencyMs, :output
           )`,
        {
          id: run.id,
          jobId: run.jobId || 'default-job',
          name: run.name || 'cron-job',
          command: run.command || '',
          startedAt: run.startedAt || Date.now(),
          finishedAt: run.finishedAt || Date.now(),
          exitCode: run.exitCode ?? 0,
          timedOut: run.timedOut ? 1 : 0,
          latencyMs: run.latencyMs ?? 0,
          output: run.output || ''
        }
      );

      // Capping: Pangkas riwayat jika melebihi batas cap (misal 500 baris)
      await conn.execute(
        `DELETE FROM olp_cron_runs
         WHERE run_id NOT IN (
           SELECT run_id FROM olp_cron_runs
           ORDER BY started_at_epoch DESC
           FETCH FIRST :cap ROWS ONLY
         )`,
        { cap: this.cap }
      );

      await conn.commit();
    });
  }
}

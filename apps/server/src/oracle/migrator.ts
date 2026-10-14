import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type oracledb from 'oracledb';

export interface MigrationFile {
  version: string;
  versionNumber: number;
  description: string;
  filename: string;
  sql: string;
  checksum: string;
  expectedTables?: string[];
}

export interface AppliedMigration {
  version: string;
  description: string;
  checksum: string;
  status: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED';
  appliedAt: Date;
  executionTimeMs?: number;
  appliedBy: string;
  errorMessage?: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Interface koneksi minimal untuk eksekusi migrasi.
 */
export interface MigrationConnection {
  execute(
    sql: string,
    binds?: oracledb.BindParameters,
    options?: oracledb.ExecuteOptions
  ): Promise<oracledb.Result<unknown>>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Menghitung checksum SHA-256 dari konten skrip SQL.
 */
export function calculateChecksum(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

/**
 * Mem-parse nama file migrasi dengan konvensi:
 * V<nomor>__<deskripsi>.sql (contoh: V001__init_migrations.sql)
 */
export function parseMigrationFilename(filename: string): { version: string; versionNumber: number; description: string } {
  const match = filename.match(/^V(\d+)__(.+)\.sql$/i);
  if (!match || !match[1] || !match[2]) {
    throw new MigrationError(
      `Invalid migration filename format: '${filename}'. Expected format: 'V<number>__<description>.sql' (e.g. V001__init.sql)`
    );
  }

  const version = `V${match[1]}`;
  const versionNumber = Number.parseInt(match[1], 10);
  const description = match[2].replace(/_/g, ' ');

  return { version, versionNumber, description };
}

/**
 * Memuat dan mengurutkan seluruh file migrasi dari direktori.
 */
export function loadMigrationFiles(dirPath: string): MigrationFile[] {
  const files = readdirSync(dirPath).filter((f) => f.endsWith('.sql'));
  const parsed = files.map((filename) => {
    const { version, versionNumber, description } = parseMigrationFilename(filename);
    const sql = readFileSync(join(dirPath, filename), 'utf8');
    const checksum = calculateChecksum(sql);
    return {
      version,
      versionNumber,
      description,
      filename,
      sql,
      checksum
    };
  });

  return parsed.sort((a, b) => a.versionNumber - b.versionNumber);
}

/**
 * Memecah skrip SQL menjadi statement-statement DDL/DML terpisah.
 * Menghilangkan komentar SQL dan membagi berdasarkan ';' di akhir baris.
 */
export function splitSqlStatements(sql: string): string[] {
  // Hapus komentar baris (-- ...)
  const stripped = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');

  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Memeriksa apakah tabel tertentu sudah ada di skema Oracle aktif.
 */
export async function checkTableExists(conn: MigrationConnection, tableName: string): Promise<boolean> {
  const result = await conn.execute(
    `SELECT table_name FROM user_tables WHERE UPPER(table_name) = UPPER(:tbl)`,
    { tbl: tableName }
  );
  return Boolean(result.rows && result.rows.length > 0);
}

/**
 * Mengakuisisi lock migrasi eksklusif agar dua proses migrator tidak berjalan bersamaan.
 */
export async function acquireMigrationLock(conn: MigrationConnection, lockedBy: string): Promise<void> {
  const hasLockTable = await checkTableExists(conn, 'OLP_MIGRATION_LOCK');
  if (!hasLockTable) {
    await conn.execute(`
      CREATE TABLE olp_migration_lock (
        lock_id NUMBER(1) NOT NULL,
        locked_by VARCHAR2(128) NOT NULL,
        locked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT pk_olp_migration_lock PRIMARY KEY (lock_id)
      )
    `);
    await conn.execute(
      `INSERT INTO olp_migration_lock (lock_id, locked_by) VALUES (1, :lockedBy)`,
      { lockedBy }
    );
    await conn.commit();
  }

  try {
    await conn.execute(
      `SELECT lock_id FROM olp_migration_lock WHERE lock_id = 1 FOR UPDATE NOWAIT`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ORA-00054') || msg.includes('resource busy')) {
      throw new MigrationError('Another migration process is currently running on this database (lock is held).');
    }
    throw err;
  }
}

/**
 * Memastikan tabel pelacak migrasi (olp_schema_migrations) ada (bootstrap).
 */
export async function bootstrapMigrationTable(conn: MigrationConnection): Promise<void> {
  const exists = await checkTableExists(conn, 'OLP_SCHEMA_MIGRATIONS');
  if (!exists) {
    await conn.execute(`
      CREATE TABLE olp_schema_migrations (
        version VARCHAR2(32) NOT NULL,
        description VARCHAR2(256) NOT NULL,
        checksum VARCHAR2(64) NOT NULL,
        status VARCHAR2(16) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        execution_time_ms NUMBER(10, 0),
        applied_by VARCHAR2(64) NOT NULL,
        error_message VARCHAR2(2000),
        CONSTRAINT pk_olp_schema_migrations PRIMARY KEY (version)
      )
    `);
  }
}

/**
 * Membaca seluruh riwayat migrasi yang pernah dicatat di database.
 */
export async function getAppliedMigrations(conn: MigrationConnection): Promise<Map<string, AppliedMigration>> {
  const result = await conn.execute(
    `SELECT version, description, checksum, status, applied_at, execution_time_ms, applied_by, error_message
     FROM olp_schema_migrations ORDER BY version ASC`
  );

  const map = new Map<string, AppliedMigration>();
  if (result.rows && Array.isArray(result.rows)) {
    for (const row of result.rows as unknown[][]) {
      const [version, description, checksum, status, appliedAt, executionTimeMs, appliedBy, errorMessage] = row;
      map.set(String(version), {
        version: String(version),
        description: String(description),
        checksum: String(checksum),
        status: status as 'IN_PROGRESS' | 'SUCCESS' | 'FAILED',
        appliedAt: new Date(String(appliedAt)),
        executionTimeMs: executionTimeMs ? Number(executionTimeMs) : undefined,
        appliedBy: String(appliedBy),
        errorMessage: errorMessage ? String(errorMessage) : undefined
      });
    }
  }
  return map;
}

export interface MigrationResult {
  appliedCount: number;
  skippedCount: number;
  appliedVersions: string[];
}

/**
 * Menjalankan migrasi berversi secara eksplisit.
 * Memvalidasi checksum, mendeteksi proses terputus, dan mengeksekusi DDL secara berurutan.
 */
export async function runVersionedMigrations(
  conn: MigrationConnection,
  migrations: MigrationFile[],
  appliedBy: string = 'olp_migrator'
): Promise<MigrationResult> {
  await acquireMigrationLock(conn, appliedBy);
  await bootstrapMigrationTable(conn);

  const appliedMap = await getAppliedMigrations(conn);
  const appliedVersions: string[] = [];
  let appliedCount = 0;
  let skippedCount = 0;

  for (const m of migrations) {
    const existing = appliedMap.get(m.version);

    if (existing) {
      // 1. Validasi Immutability: Checksum skrip yang sudah sukses tidak boleh berubah
      if (existing.status === 'SUCCESS') {
        if (existing.checksum !== m.checksum) {
          throw new MigrationError(
            `Migration checksum mismatch for ${m.version}: recorded '${existing.checksum}', but local file has '${m.checksum}'. Migration files are immutable once applied!`
          );
        }
        skippedCount++;
        continue;
      }

      // 2. Deteksi Kegagalan atau Crash Sebelumnya (IN_PROGRESS atau FAILED)
      if (existing.status === 'IN_PROGRESS' || existing.status === 'FAILED') {
        // Karena Oracle DDL melakukan implicit commit, periksa keberadaan objek sebagian
        if (m.expectedTables && m.expectedTables.length > 0) {
          const partialTables: string[] = [];
          for (const tbl of m.expectedTables) {
            if (await checkTableExists(conn, tbl)) {
              partialTables.push(tbl);
            }
          }
          if (partialTables.length > 0) {
            throw new MigrationError(
              `Migration ${m.version} previously crashed (${existing.status}). Partial database objects detected: [${partialTables.join(', ')}]. DDL cannot be rolled back automatically in Oracle due to implicit commit. Manual DBA inspection/cleanup is required before re-running.`
            );
          }
        }
      }
    }

    // 3. Catat status IN_PROGRESS sebelum mengeksekusi DDL
    const startTime = Date.now();
    await conn.execute(
      `MERGE INTO olp_schema_migrations dst
       USING (SELECT :ver AS version FROM dual) src
       ON (dst.version = src.version)
       WHEN MATCHED THEN
         UPDATE SET status = 'IN_PROGRESS', checksum = :chk, description = :descr, applied_at = CURRENT_TIMESTAMP, applied_by = :appBy, error_message = NULL
       WHEN NOT MATCHED THEN
         INSERT (version, description, checksum, status, applied_by)
         VALUES (:ver, :descr, :chk, 'IN_PROGRESS', :appBy)`,
      {
        ver: m.version,
        descr: m.description,
        chk: m.checksum,
        appBy: appliedBy
      }
    );
    await conn.commit();

    // 4. Eksekusi Pernyataan SQL dalam file migrasi satu per satu
    const statements = splitSqlStatements(m.sql);
    try {
      for (const statement of statements) {
        await conn.execute(statement);
      }

      const executionTimeMs = Date.now() - startTime;
      await conn.execute(
        `UPDATE olp_schema_migrations
         SET status = 'SUCCESS', execution_time_ms = :execTime
         WHERE version = :ver`,
        { execTime: executionTimeMs, ver: m.version }
      );
      await conn.commit();

      appliedCount++;
      appliedVersions.push(m.version);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        await conn.execute(
          `UPDATE olp_schema_migrations
           SET status = 'FAILED', error_message = :err
           WHERE version = :ver`,
          { err: errMsg.slice(0, 1999), ver: m.version }
        );
        await conn.commit();
      } catch {
        // Catat error kegagalan
      }

      throw new MigrationError(
        `Migration ${m.version} failed: ${errMsg}. Note: Statements executed prior to failure committed implicitly in Oracle.`
      );
    }
  }

  return { appliedCount, skippedCount, appliedVersions };
}

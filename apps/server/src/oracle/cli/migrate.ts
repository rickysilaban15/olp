import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OraclePoolManager } from '../oracle-pool.js';
import { runVersionedMigrations, loadMigrationFiles } from '../migrator.js';
import type { MigrationConnection } from '../migrator.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(currentDir, '..', 'migrations');

/**
 * Runner eksplisit untuk migrasi DDL Oracle Database.
 * Sesuai prinsip least-privilege, migrasi DDL dijalankan secara terpisah dari startup aplikasi.
 */
export async function runMigrationCli(): Promise<void> {
  console.log('[OLP-Oracle] Menjalankan migrasi skema berversi (V001..V007)...');
  const pool = new OraclePoolManager();
  await pool.initialize();
  try {
    const migrations = loadMigrationFiles(migrationsDir);
    const result = await pool.withConnection(async (conn) => {
      return runVersionedMigrations(conn as unknown as MigrationConnection, migrations);
    });
    console.log(`[OLP-Oracle] Berhasil: ${result.appliedCount} migrasi baru diterapkan, ${result.skippedCount} dilewati.`);
    for (const v of result.appliedVersions) {
      console.log(`  - Versi diterapkan: ${v}`);
    }
  } catch (err) {
    console.error('[OLP-Oracle] Migrasi gagal:', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await pool.close();
  }
}

// Jalankan otomatis jika dipanggil langsung via CLI
if (process.argv[1] && (process.argv[1].includes('migrate.ts') || process.argv[1].includes('migrate.js'))) {
  runMigrationCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

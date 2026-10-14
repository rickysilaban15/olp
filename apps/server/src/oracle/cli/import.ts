import { OraclePoolManager } from '../oracle-pool.js';
import { JsonImporter } from '../json-importer.js';
import { resolveDirs } from '../../auth.js';

/**
 * Runner eksplisit untuk import data JSON ke Oracle Database.
 * Non-destruktif: file sumber JSON tidak dimodifikasi atau dihapus.
 * Idempotent: aman dijalankan berulang kali.
 */
export async function runImportCli(): Promise<void> {
  const dirs = resolveDirs();
  const dataDir = process.env['OLP_DATA_DIR'] || dirs.dataDir;
  console.log(`[OLP-Oracle] Memulai import data JSON non-destruktif dari: ${dataDir}`);

  const pool = new OraclePoolManager();
  await pool.initialize();
  try {
    const importer = new JsonImporter(pool, dataDir);
    const summary = await importer.importAll();

    console.log('\n=== Laporan Hasil Import JSON ke Oracle Database ===');
    console.log(`Waktu Pelaksanaan  : ${summary.timestamp}`);
    console.log(`Status Keseluruhan : ${summary.overallSuccess ? 'BERHASIL' : 'ADA KEGAGALAN'}`);
    console.log('\nRincian per entitas:');
    for (const r of summary.reports) {
      console.log(`  - File Sumber: ${r.sourceFile} (ada: ${r.sourceFound ? 'YA' : 'TIDAK'})`);
      console.log(`      Data Sumber       : ${r.sourceRecords}`);
      console.log(`      Berhasil Diimpor  : ${r.importedRecords}`);
      console.log(`      Dilewati (ada)    : ${r.skippedRecords}`);
      console.log(`      Gagal             : ${r.failedRecords}`);
      console.log(`      Validasi Pasca-DB : ${r.validationPassed ? 'LULUS' : 'GAGAL'}`);
      if (r.error) {
        console.log(`      Pesan Error       : ${r.error}`);
      }
    }

    if (!summary.overallSuccess) {
      console.error('\n[OLP-Oracle] Import selesai dengan beberapa kegagalan. Periksa log di atas.');
      process.exitCode = 1;
    } else {
      console.log('\n[OLP-Oracle] Semua data JSON berhasil diimpor dan divalidasi ke Oracle.');
    }
  } catch (err) {
    console.error('[OLP-Oracle] Import mengalami kegagalan fatal:', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await pool.close();
  }
}

// Jalankan otomatis jika dipanggil langsung via CLI
if (process.argv[1] && (process.argv[1].includes('import.ts') || process.argv[1].includes('import.js'))) {
  runImportCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

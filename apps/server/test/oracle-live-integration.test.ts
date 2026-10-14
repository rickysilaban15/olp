import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import oracledb from 'oracledb';
import * as net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { OraclePoolManager } from '../src/oracle/oracle-pool.js';
import { runVersionedMigrations, loadMigrationFiles } from '../src/oracle/migrator.js';
import {
  OracleSiteStore,
  OracleProxyStore,
  OracleSettingsStore,
  OracleCronStore,
  OracleDbRegistry,
  OracleAuthStore
} from '../src/oracle/stores/index.js';
import { JsonImporter } from '../src/oracle/json-importer.js';
import { OracleBackupManager } from '../src/oracle/oracle-backup.js';
import { createStorageBundle } from '../src/oracle/storage-factory.js';
import { buildServer } from '../src/index.js';

const ORACLE_HOST = process.env['OLP_ORACLE_HOST'] || '127.0.0.1';
const ORACLE_PORT = Number(process.env['OLP_ORACLE_PORT']) || 1521;
const ORACLE_SERVICE = process.env['OLP_ORACLE_SERVICE_NAME'] || 'FREEPDB1';
const ORACLE_USER = process.env['OLP_ORACLE_USER'] || 'olp_app';
const ORACLE_PASSWORD = process.env['OLP_ORACLE_PASSWORD'] || 'olp_secret_pass_123#';

// Probe TCP port
function isOraclePortOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

describe('Oracle Live Integration Test Suite (Thin Mode, Migrations, Stores, Importer, Backup, Server)', () => {
  let isAvailable = false;
  let poolManager: OraclePoolManager;
  const testMasterKey = randomBytes(32);
  let testDataDir: string;

  beforeAll(async () => {
    isAvailable = await isOraclePortOpen(ORACLE_HOST, ORACLE_PORT);
    if (!isAvailable) {
      console.warn(`[SKIP] Oracle Database tidak terdeteksi di ${ORACLE_HOST}:${ORACLE_PORT}. Live integration test dilewati.`);
      return;
    }

    testDataDir = mkdtempSync(join(tmpdir(), 'olp-oracle-test-'));

    process.env['OLP_ORACLE_HOST'] = ORACLE_HOST;
    process.env['OLP_ORACLE_PORT'] = String(ORACLE_PORT);
    process.env['OLP_ORACLE_SERVICE_NAME'] = ORACLE_SERVICE;
    process.env['OLP_ORACLE_USER'] = ORACLE_USER;
    process.env['OLP_ORACLE_PASSWORD'] = ORACLE_PASSWORD;
    process.env['OLP_MASTER_KEY'] = testMasterKey.toString('hex');

    poolManager = new OraclePoolManager();
    await poolManager.initialize();
  });

  afterAll(async () => {
    if (poolManager) {
      await poolManager.close().catch(() => '');
    }
    if (testDataDir) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it('1. Verifikasi koneksi TCP Oracle Thin Mode murni', async () => {
    if (!isAvailable) return;
    expect(oracledb.thin).toBe(true);

    const ping = await poolManager.ping();
    expect(ping).toBe(true);
  });

  it('2. Eksekusi Migrasi DDL V001..V007 dan verifikasi katalog USER_TABLES', async () => {
    if (!isAvailable) return;

    const migrationsDir = join(__dirname, '../src/oracle/migrations');
    const migrations = loadMigrationFiles(migrationsDir);
    expect(migrations.length).toBeGreaterThanOrEqual(7);

    const result = await poolManager.withConnection(async (conn) => {
      return runVersionedMigrations(conn as any, migrations, 'live_test_suite');
    });

    expect(result.appliedCount + result.skippedCount).toBe(migrations.length);

    // Verifikasi objek pada katalog USER_TABLES
    await poolManager.withConnection(async (conn) => {
      const res = await conn.execute(`SELECT table_name FROM user_tables`);
      const tables = (res.rows as string[][]).map((r) => r[0].toUpperCase());

      expect(tables).toContain('OLP_SCHEMA_MIGRATIONS');
      expect(tables).toContain('OLP_MIGRATION_LOCK');
      expect(tables).toContain('OLP_OPERATOR');
      expect(tables).toContain('OLP_PASSKEYS');
      expect(tables).toContain('OLP_SITES');
      expect(tables).toContain('OLP_PROXIES');
      expect(tables).toContain('OLP_SETTINGS');
      expect(tables).toContain('OLP_CRON_RUNS');
      expect(tables).toContain('OLP_DB_CONNECTIONS');
      expect(tables).toContain('OLP_BACKUP_SCHEDULES');
      expect(tables).toContain('OLP_BACKUP_METADATA');
      expect(tables).toContain('OLP_BACKUP_BUNDLES');
    });
  });

  it('3. Verifikasi konkurensi row locking migrasi (ORA-00054 NOWAIT)', async () => {
    if (!isAvailable) return;

    // Koneksi 1 mengunci baris lock
    const conn1 = await poolManager.getConnection();
    const conn2 = await poolManager.getConnection();

    try {
      await conn1.execute(
        `SELECT lock_id FROM olp_migration_lock WHERE lock_id = 1 FOR UPDATE NOWAIT`
      );

      // Koneksi 2 mencoba mengunci baris yang sama dengan NOWAIT -> harus melempar ORA-00054
      let lockConflict = false;
      try {
        await conn2.execute(
          `SELECT lock_id FROM olp_migration_lock WHERE lock_id = 1 FOR UPDATE NOWAIT`
        );
      } catch (err: any) {
        if (err.message && (err.message.includes('ORA-00054') || err.message.includes('resource busy'))) {
          lockConflict = true;
        }
      }
      expect(lockConflict).toBe(true);
    } finally {
      await conn1.rollback();
      await conn1.close();
      await conn2.close();
    }
  });

  it('4. CRUD lengkap untuk seluruh Oracle Store', async () => {
    if (!isAvailable) return;

    // Site Store
    const siteStore = new OracleSiteStore(poolManager);
    await siteStore.save([
      { id: 'site-live-1', name: 'Frontend App', type: 'static', path: '/var/www/front', port: 3000, created: 1700000000 },
      { id: 'site-live-2', name: 'Backend API', type: 'node', path: '/var/www/api', port: 4000, created: 1700000010 }
    ]);
    const sites = await siteStore.list();
    expect(sites.length).toBe(2);
    expect(sites[0].id).toBe('site-live-1');

    // Proxy Store
    const proxyStore = new OracleProxyStore(poolManager);
    await proxyStore.save([
      { id: 'px-1', name: 'Main Proxy', listenPort: 80, domain: 'app.local', targetPort: 3000, created: 1700000000 }
    ]);
    const proxies = await proxyStore.list();
    expect(proxies.length).toBe(1);
    expect(proxies[0].domain).toBe('app.local');

    // Settings Store (dengan enkripsi secret)
    const settingsStore = new OracleSettingsStore(poolManager, testMasterKey);
    await settingsStore.save({
      telegram: { botToken: 'secret_live_bot_token_123', chatId: '123456789', enabled: true, commandsEnabled: true },
      bind: { host: '127.0.0.1', port: 8080 }
    });
    const loadedSettings = await settingsStore.load();
    expect(loadedSettings.telegram.botToken).toBe('secret_live_bot_token_123');
    expect(loadedSettings.telegram.chatId).toBe('123456789');

    // Cron Store
    const cronStore = new OracleCronStore(poolManager);
    await cronStore.append({
      id: 'cron-run-1',
      jobId: 'job-1',
      name: 'Backup Cron',
      command: 'olp backup',
      startedAt: 1700000000,
      finishedAt: 1700000120,
      exitCode: 0,
      timedOut: false,
      latencyMs: 120,
      output: 'backup success'
    });
    const runs = await cronStore.list(10);
    expect(runs.length).toBeGreaterThanOrEqual(1);

    // Database Registry (dengan enkripsi password)
    const dbRegistry = new OracleDbRegistry(poolManager, testMasterKey);
    await dbRegistry.save({
      mysql: { host: 'mysql.internal', port: 3306, user: 'app_user', password: 'secret_mysql_password_live', database: 'crm' }
    });
    const dbConfigs = await dbRegistry.load();
    expect(dbConfigs.mysql?.password).toBe('secret_mysql_password_live');

    // Auth Store
    const authStore = new OracleAuthStore(poolManager);
    await authStore.saveConfig({
      username: 'live_admin',
      salt: 'salt_abc_123',
      hash: 'hash_xyz_456',
      passkeys: [
        { id: 'pk-live-1', publicKey: 'pubkey1', counter: 0, name: 'YubiKey Live', created: 1700000000 }
      ]
    }, 'live_admin_id');
    const authConfig = await authStore.loadConfig('live_admin_id');
    expect(authConfig?.username).toBe('live_admin');
    expect(authConfig?.passkeys.length).toBe(1);
  });

  it('5. Importer JSON terkontrol (Idempotent 2x, validasi, non-destruktif)', async () => {
    if (!isAvailable) return;

    const fixtureDir = mkdtempSync(join(tmpdir(), 'olp-fixture-'));
    try {
      // Siapkan file sumber JSON tiruan
      const configJson = {
        username: 'imported_admin',
        salt: 'import_salt',
        hash: 'import_hash',
        passkeys: [{ id: 'pk-imp-1', publicKey: 'pk1', counter: 1, name: 'Mac TouchID', created: 1700001000 }]
      };
      const sitesJson = [
        { id: 'imp-site-1', name: 'Shop', type: 'static', path: '/srv/shop', port: 5000, created: 1700002000 }
      ];
      const settingsJson = {
        telegram: { botToken: 'imported_bot_token_999', chatId: '999888', enabled: true, commandsEnabled: true },
        bind: { host: '0.0.0.0', port: 9000 }
      };

      writeFileSync(join(fixtureDir, 'config.json'), JSON.stringify(configJson));
      writeFileSync(join(fixtureDir, 'sites.json'), JSON.stringify(sitesJson));
      writeFileSync(join(fixtureDir, 'settings.json'), JSON.stringify(settingsJson));

      const hashBefore = readFileSync(join(fixtureDir, 'config.json'), 'utf8');

      const importer = new JsonImporter(poolManager, fixtureDir, testMasterKey);

      // Jalankan Run #1
      const report1 = await importer.importAll();
      expect(report1.overallSuccess).toBe(true);

      // Jalankan Run #2 (harus idempotent, records dilewati, tidak ada duplikasi)
      const report2 = await importer.importAll();
      expect(report2.overallSuccess).toBe(true);

      // Pastikan file sumber tidak dimodifikasi
      const hashAfter = readFileSync(join(fixtureDir, 'config.json'), 'utf8');
      expect(hashAfter).toBe(hashBefore);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('6. Snapshot Backup & Atomic Restore ke database', async () => {
    if (!isAvailable) return;

    const backupManager = new OracleBackupManager(poolManager, testMasterKey);

    // 1. Ekspor snapshot
    const dump = await backupManager.exportBundleConfigs();
    expect(dump.sites.length).toBeGreaterThanOrEqual(1);

    // 2. Modifikasi state
    const siteStore = new OracleSiteStore(poolManager);
    await siteStore.save([]); // kosongkan situs

    const clearedSites = await siteStore.list();
    expect(clearedSites.length).toBe(0);

    // 3. Restore kembali dari snapshot
    const restoreReport = await backupManager.restoreBundleConfigs(dump, 'live_admin_id');
    if (!restoreReport.success) {
      console.error('RESTORE FAILED:', restoreReport.error);
    }
    expect(restoreReport.success).toBe(true);
    expect(restoreReport.restoredSitesCount).toBe(dump.sites.length);

    // 4. Verifikasi bahwa situs kembali utuh
    const restoredSites = await siteStore.list();
    expect(restoredSites.length).toBe(dump.sites.length);
  });

  it('7. Server Fastify boot dengan OLP_STORAGE_MODE=oracle & Zero Silent Fallback', async () => {
    if (!isAvailable) return;

    // 1. Sukses boot dengan Oracle aktif
    const bundle = await createStorageBundle(testDataDir, {
      OLP_STORAGE_MODE: 'oracle',
      OLP_ORACLE_HOST: ORACLE_HOST,
      OLP_ORACLE_PORT: String(ORACLE_PORT),
      OLP_ORACLE_SERVICE_NAME: ORACLE_SERVICE,
      OLP_ORACLE_USER: ORACLE_USER,
      OLP_ORACLE_PASSWORD: ORACLE_PASSWORD,
      OLP_MASTER_KEY: testMasterKey.toString('hex')
    }, testMasterKey);

    expect(bundle.mode).toBe('oracle');
    expect(bundle.poolManager).not.toBeNull();

    const serverHandle = buildServer({
      dataDir: testDataDir,
      siteStore: bundle.siteStore,
      settingsStore: bundle.settingsStore,
      dbRegistry: bundle.dbRegistry,
      webDir: null
    });

    const res = await serverHandle.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'olp' });

    await serverHandle.app.close();

    // 2. Verifikasi Zero Silent Fallback (jika oracle gagal, DILARANG fallback diam-diam ke json)
    let fallbackBlocked = false;
    try {
      await createStorageBundle(testDataDir, {
        OLP_STORAGE_MODE: 'oracle',
        OLP_ORACLE_HOST: '127.0.0.1',
        OLP_ORACLE_PORT: '59999', // port mati
        OLP_ORACLE_CONNECT_TIMEOUT: '500',
        OLP_ORACLE_MAX_RETRIES: '0'
      });
    } catch {
      fallbackBlocked = true;
    }
    expect(fallbackBlocked).toBe(true);
  });
});

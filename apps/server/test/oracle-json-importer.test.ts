import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { JsonImporter } from '../src/oracle/json-importer.js';
import type { OraclePoolManager } from '../src/oracle/oracle-pool.js';
import type { MigrationConnection } from '../src/oracle/migrator.js';

describe('JsonImporter (Idempotent JSON to Oracle Importer)', () => {
  let tempDir: string;
  const masterKey = randomBytes(32);

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'olp-importer-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('imports valid JSON files non-destructively and validates results', async () => {
    // 1. Siapkan fixture file JSON sumber
    const authData = {
      username: 'admin_test',
      salt: 'salt123',
      hash: 'hash123',
      passkeys: [
        { id: 'pk1', publicKey: 'cose-key-1', counter: 0, name: 'YubiKey', created: 1000 }
      ]
    };
    writeFileSync(join(tempDir, 'config.json'), JSON.stringify(authData));

    const sitesData = [
      { id: 's1', name: 'My Website', type: 'node', path: 'sites/s1', port: 3000, created: 2000 }
    ];
    writeFileSync(join(tempDir, 'sites.json'), JSON.stringify(sitesData));

    const proxiesData = [
      { id: 'p1', name: 'Proxy 1', listenPort: 80, domain: 'example.com', targetPort: 3000, created: 2100 }
    ];
    writeFileSync(join(tempDir, 'nginx.json'), JSON.stringify(proxiesData));

    const settingsData = {
      telegram: { botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', chatId: '987654', enabled: true, commandsEnabled: true },
      bind: { host: '0.0.0.0', port: 8080 }
    };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settingsData));

    const cronData = [
      { id: 'c1', jobId: 'j1', name: 'Backup Nightly', command: 'olp backup', startedAt: 3000, finishedAt: 3100, exitCode: 0, timedOut: false, latencyMs: 100, output: 'done' }
    ];
    writeFileSync(join(tempDir, 'cron-runs.json'), JSON.stringify(cronData));

    const dbData = {
      mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: 'mysqlpassword', database: 'appdb' }
    };
    writeFileSync(join(tempDir, 'db.json'), JSON.stringify(dbData));

    const backupsDir = join(tempDir, 'backups');
    mkdirSync(backupsDir);
    const schedulesData = [
      { id: 'sched1', name: 'Daily Sched', type: 'mysql', source: 'appdb', schedule: '0 0 * * *', enabled: true, created: 4000, lastRun: null, lastStatus: null }
    ];
    writeFileSync(join(backupsDir, 'backup-schedules.json'), JSON.stringify(schedulesData));

    // 2. Siapkan mock OraclePoolManager & Connection
    const executedSql: string[] = [];
    const boundParams: Record<string, unknown>[] = [];

    const mockConn: MigrationConnection = {
      execute: vi.fn().mockImplementation(async (sql: string, binds?: Record<string, unknown>) => {
        executedSql.push(sql);
        if (binds) boundParams.push(binds);

        if (sql.includes('SELECT COUNT(*) FROM olp_operator')) {
          return { rows: [[1]] };
        }
        if (sql.includes('SELECT COUNT(*) FROM olp_sites')) {
          return { rows: [[1]] };
        }
        if (sql.includes('SELECT COUNT(*) FROM olp_proxies')) {
          return { rows: [[1]] };
        }
        return { rowsAffected: 1 };
      }),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined)
    };

    const mockPoolManager = {
      withConnection: vi.fn().mockImplementation(async (cb: (c: MigrationConnection) => Promise<unknown>) => {
        return cb(mockConn);
      })
    } as unknown as OraclePoolManager;

    // 3. Jalankan importer
    const importer = new JsonImporter(mockPoolManager, tempDir, masterKey);
    const report = await importer.importAll();

    expect(report.overallSuccess).toBe(true);
    expect(report.reports.length).toBe(8);

    // Verifikasi masing-masing entitas
    const authReport = report.reports.find((r) => r.entity === 'auth')!;
    expect(authReport.sourceFound).toBe(true);
    expect(authReport.importedRecords).toBe(2); // 1 operator + 1 passkey
    expect(authReport.validationPassed).toBe(true);

    const siteReport = report.reports.find((r) => r.entity === 'sites')!;
    expect(siteReport.sourceFound).toBe(true);
    expect(siteReport.importedRecords).toBe(1);

    const proxyReport = report.reports.find((r) => r.entity === 'proxies')!;
    expect(proxyReport.importedRecords).toBe(1);

    const settingsReport = report.reports.find((r) => r.entity === 'settings')!;
    expect(settingsReport.importedRecords).toBe(1);

    const dbReport = report.reports.find((r) => r.entity === 'databases')!;
    expect(dbReport.importedRecords).toBe(1);

    // 4. Verifikasi enkripsi secret pada parameter binds
    const settingsBind = boundParams.find((b) => b['chatId'] === '987654');
    expect(settingsBind).toBeDefined();
    expect(settingsBind!['token']).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/); // AES-256-GCM format!
    expect(settingsBind!['token']).not.toContain('123456:ABC'); // Plaintext is not stored!

    const dbBind = boundParams.find((b) => b['eng'] === 'mysql');
    expect(dbBind).toBeDefined();
    expect(dbBind!['pwd']).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/); // Encrypted password!
    expect(dbBind!['pwd']).not.toBe('mysqlpassword'); // Plaintext is not stored!

    // 5. Verifikasi Non-Destruktif: File JSON sumber tetap ada dan tidak diubah!
    expect(existsSync(join(tempDir, 'config.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'sites.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'nginx.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'settings.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'cron-runs.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'db.json'))).toBe(true);
    expect(existsSync(join(backupsDir, 'backup-schedules.json'))).toBe(true);
  });
});

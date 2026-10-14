import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { OracleBackupManager, type BundleConfigDump } from '../src/oracle/oracle-backup.js';
import type { OraclePoolManager } from '../src/oracle/oracle-pool.js';
import type { MigrationConnection } from '../src/oracle/migrator.js';

describe('OracleBackupManager (Backup/Restore Compatibility)', () => {
  const masterKey = randomBytes(32);

  it('exports and restores bundle configs cleanly', async () => {
    const executedSql: string[] = [];

    const mockConn: MigrationConnection = {
      execute: vi.fn().mockImplementation(async (sql: string) => {
        executedSql.push(sql);
        if (sql.includes('FROM olp_operator')) {
          return { rows: [['op1', 'admin_bak', 'salt1', 'hash1']] };
        }
        if (sql.includes('FROM olp_passkeys')) {
          return { rows: [['pk1', 'pubkey1', 0, 'Yubikey', 1000]] };
        }
        if (sql.includes('FROM olp_sites')) {
          return { rows: [['s1', 'Site 1', 'node', 'sites/s1', 3000, 1000]] };
        }
        if (sql.includes('FROM olp_proxies')) {
          return { rows: [['p1', 'Proxy 1', 80, 'test.com', 3000, 1000]] };
        }
        if (sql.includes('FROM olp_settings')) {
          return { rows: [['', '12345', 1, 1, '127.0.0.1', 8080]] };
        }
        if (sql.includes('FROM olp_db_connections')) {
          return { rows: [['def-mysql', 'MySQL', 'mysql', '127.0.0.1', 3306, 'root', '', 'appdb', 1]] };
        }
        return { rowsAffected: 1 };
      }),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined)
    };

    const mockPool = {
      withConnection: vi.fn().mockImplementation(async (cb: (c: MigrationConnection) => Promise<unknown>) => cb(mockConn))
    } as unknown as OraclePoolManager;

    const manager = new OracleBackupManager(mockPool, masterKey);

    // 1. Test export
    const exported = await manager.exportBundleConfigs();
    expect(exported.auth?.username).toBe('admin_bak');
    expect(exported.sites.length).toBe(1);
    expect(exported.nginx.length).toBe(1);
    expect(exported.settings.bind?.port).toBe(8080);
    expect(exported.db.mysql?.host).toBe('127.0.0.1');

    // 2. Test restore
    const sampleRestoreDump: BundleConfigDump = {
      auth: {
        username: 'restored_admin',
        salt: 'newsalt',
        hash: 'newhash',
        passkeys: []
      },
      sites: [
        { id: 's2', name: 'Site 2', type: 'php', path: 'sites/s2', port: 8000, created: 2000 }
      ],
      nginx: [
        { id: 'p2', name: 'Proxy 2', listenPort: 443, domain: 'secure.com', targetPort: 8000, created: 2000 }
      ],
      settings: {
        telegram: { botToken: 'tok', chatId: 'chat', enabled: true, commandsEnabled: true },
        bind: null
      },
      db: {
        postgres: { host: 'localhost', port: 5432, user: 'pg', password: 'pwd', database: 'pgdb' }
      }
    };

    const restoreReport = await manager.restoreBundleConfigs(sampleRestoreDump, 'restored_op_id');
    expect(restoreReport.success).toBe(true);
    expect(restoreReport.restoredAuth).toBe(true);
    expect(restoreReport.restoredSitesCount).toBe(1);
    expect(restoreReport.restoredProxiesCount).toBe(1);
    expect(restoreReport.restoredSettings).toBe(true);
    expect(restoreReport.restoredDatabasesCount).toBe(1);

    expect(executedSql.some((s) => s.includes('MERGE INTO olp_operator'))).toBe(true);
    expect(executedSql.some((s) => s.includes('MERGE INTO olp_sites'))).toBe(true);
    expect(executedSql.some((s) => s.includes('MERGE INTO olp_proxies'))).toBe(true);
    expect(executedSql.some((s) => s.includes('MERGE INTO olp_settings'))).toBe(true);
    expect(executedSql.some((s) => s.includes('MERGE INTO olp_db_connections'))).toBe(true);
  });
});

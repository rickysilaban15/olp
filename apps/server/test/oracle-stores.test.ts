import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  OracleSiteStore,
  OracleProxyStore,
  OracleSettingsStore,
  OracleCronStore,
  OracleDbRegistry,
  OracleAuthStore
} from '../src/oracle/stores/index.js';
import type { OraclePoolManager } from '../src/oracle/oracle-pool.js';
import type { MigrationConnection } from '../src/oracle/migrator.js';

describe('Oracle Store Repositories', () => {
  const masterKey = randomBytes(32);

  describe('OracleSiteStore', () => {
    it('lists and saves sites round-trip', async () => {
      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT site_id, name, site_type')) {
            return {
              rows: [
                ['s1', 'My Site', 'node', 'sites/s1', 3000, 1000]
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const mockPool = {
        withConnection: vi.fn().mockImplementation(async (cb: (c: MigrationConnection) => Promise<unknown>) => cb(mockConn))
      } as unknown as OraclePoolManager;

      const store = new OracleSiteStore(mockPool);
      const sites = await store.list();
      expect(sites.length).toBe(1);
      expect(sites[0]!.id).toBe('s1');
      expect(sites[0]!.name).toBe('My Site');
      expect(sites[0]!.type).toBe('node');
      expect(sites[0]!.port).toBe(3000);

      await store.save(sites);
      expect(mockConn.execute).toHaveBeenCalledWith(
        expect.stringContaining('MERGE INTO olp_sites'),
        expect.objectContaining({ id: 's1', name: 'My Site', port: 3000 })
      );
      expect(mockConn.commit).toHaveBeenCalled();
    });
  });

  describe('OracleProxyStore', () => {
    it('lists and saves proxies round-trip', async () => {
      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT proxy_id, name, listen_port')) {
            return {
              rows: [
                ['p1', 'Main Proxy', 80, 'example.com', 3000, 1500]
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const mockPool = {
        withConnection: vi.fn().mockImplementation(async (cb: (c: MigrationConnection) => Promise<unknown>) => cb(mockConn))
      } as unknown as OraclePoolManager;

      const store = new OracleProxyStore(mockPool);
      const proxies = await store.list();
      expect(proxies.length).toBe(1);
      expect(proxies[0]!.id).toBe('p1');
      expect(proxies[0]!.domain).toBe('example.com');

      await store.save(proxies);
      expect(mockConn.execute).toHaveBeenCalledWith(
        expect.stringContaining('MERGE INTO olp_proxies'),
        expect.objectContaining({ id: 'p1', domain: 'example.com' })
      );
    });
  });

  describe('OracleSettingsStore', () => {
    it('saves encrypted token and loads decrypted token', async () => {
      let savedTokenCipher: string | null = null;

      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string, binds?: Record<string, unknown>) => {
          if (sql.includes('MERGE INTO olp_settings')) {
            savedTokenCipher = binds?.['token'] as string;
            return { rowsAffected: 1 };
          }
          if (sql.includes('SELECT telegram_bot_token_encrypted')) {
            return {
              rows: [
                [savedTokenCipher, '12345', 1, 1, '127.0.0.1', 8080]
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const mockPool = {
        withConnection: vi.fn().mockImplementation(async (cb: (c: MigrationConnection) => Promise<unknown>) => cb(mockConn))
      } as unknown as OraclePoolManager;

      const store = new OracleSettingsStore(mockPool, masterKey);

      await store.save({
        telegram: { botToken: 'secret-telegram-token', chatId: '12345', enabled: true, commandsEnabled: true },
        bind: { host: '127.0.0.1', port: 8080 }
      });

      expect(savedTokenCipher).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
      expect(savedTokenCipher).not.toContain('secret-telegram-token');

      const loaded = await store.load();
      expect(loaded.telegram.botToken).toBe('secret-telegram-token');
      expect(loaded.telegram.chatId).toBe('12345');
      expect(loaded.bind?.port).toBe(8080);
    });
  });

  describe('OracleCronStore', () => {
    it('lists and appends cron runs with capping', async () => {
      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT run_id, job_id, name')) {
            return {
              rows: [
                ['r1', 'j1', 'Run 1', 'echo 1', 1000, 1050, 0, 0, 50, 'ok']
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const mockPool = {
        withConnection: vi.fn().mockImplementation(async (cb: (c: MigrationConnection) => Promise<unknown>) => cb(mockConn))
      } as unknown as OraclePoolManager;

      const store = new OracleCronStore(mockPool, 100);
      const runs = await store.list(10);
      expect(runs.length).toBe(1);
      expect(runs[0]!.id).toBe('r1');
      expect(runs[0]!.output).toBe('ok');

      await store.append({
        id: 'r2',
        jobId: 'j1',
        name: 'Run 2',
        command: 'echo 2',
        startedAt: 2000,
        finishedAt: 2050,
        exitCode: 0,
        timedOut: false,
        latencyMs: 50,
        output: 'done'
      });

      expect(mockConn.execute).toHaveBeenCalledWith(
        expect.stringMatching(/(INSERT|MERGE) INTO olp_cron_runs/),
        expect.objectContaining({ id: 'r2', name: 'Run 2' })
      );
      expect(mockConn.execute).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM olp_cron_runs'),
        expect.objectContaining({ cap: 100 })
      );
    });
  });

  describe('OracleDbRegistry', () => {
    it('saves encrypted db password and loads decrypted password', async () => {
      let savedPwdCipher: string | null = null;

      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string, binds?: Record<string, unknown>) => {
          if (sql.includes('MERGE INTO olp_db_connections')) {
            savedPwdCipher = binds?.['pwd'] as string;
            return { rowsAffected: 1 };
          }
          if (sql.includes('SELECT connection_id, name, engine')) {
            return {
              rows: [
                ['default-mysql', 'Default MySQL', 'mysql', '127.0.0.1', 3306, 'root', savedPwdCipher, 'appdb', 1]
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const mockPool = {
        withConnection: vi.fn().mockImplementation(async (cb: (c: MigrationConnection) => Promise<unknown>) => cb(mockConn))
      } as unknown as OraclePoolManager;

      const registry = new OracleDbRegistry(mockPool, masterKey);

      await registry.save({
        mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: 'plain-database-pwd', database: 'appdb' }
      });

      expect(savedPwdCipher).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
      expect(savedPwdCipher).not.toContain('plain-database-pwd');

      const loaded = await registry.load();
      expect(loaded.mysql).toBeDefined();
      expect(loaded.mysql!.password).toBe('plain-database-pwd');
      expect(loaded.mysql!.database).toBe('appdb');
    });
  });

  describe('OracleAuthStore', () => {
    it('loads and saves operator credentials and passkeys', async () => {
      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FROM olp_operator')) {
            return {
              rows: [
                ['op-uuid-1', 'admin_secure', 'salt_hex', 'hash_argon']
              ]
            };
          }
          if (sql.includes('FROM olp_passkeys')) {
            return {
              rows: [
                ['pk-cred-1', 'pubkey-cose-base64', 3, 'My Security Key', 5000]
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const mockPool = {
        withConnection: vi.fn().mockImplementation(async (cb: (c: MigrationConnection) => Promise<unknown>) => cb(mockConn))
      } as unknown as OraclePoolManager;

      const authStore = new OracleAuthStore(mockPool);
      const config = await authStore.loadConfig();

      expect(config).not.toBeNull();
      expect(config!.username).toBe('admin_secure');
      expect(config!.passkeys.length).toBe(1);
      expect(config!.passkeys[0]!.id).toBe('pk-cred-1');
      expect(config!.passkeys[0]!.counter).toBe(3);

      await authStore.saveConfig(config!, 'op-uuid-1');
      expect(mockConn.execute).toHaveBeenCalledWith(
        expect.stringContaining('MERGE INTO olp_operator'),
        expect.objectContaining({ opId: 'op-uuid-1', username: 'admin_secure' })
      );
      expect(mockConn.execute).toHaveBeenCalledWith(
        expect.stringContaining('MERGE INTO olp_passkeys'),
        expect.objectContaining({ credId: 'pk-cred-1', opId: 'op-uuid-1' })
      );
    });
  });
});

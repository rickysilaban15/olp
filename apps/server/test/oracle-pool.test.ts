import { describe, it, expect, vi } from 'vitest';
import type oracledb from 'oracledb';
import {
  OraclePoolManager,
  resolveOracleConfig,
  OraclePoolError,
  type OracleDriverInterface
} from '../src/oracle/oracle-pool.js';

describe('OraclePoolManager', () => {
  describe('resolveOracleConfig', () => {
    it('provides secure defaults bound to localhost', () => {
      const config = resolveOracleConfig({});
      expect(config.host).toBe('127.0.0.1');
      expect(config.port).toBe(1521);
      expect(config.serviceName).toBe('FREEPDB1');
      expect(config.user).toBe('olp_app');
      expect(config.poolMin).toBe(2);
      expect(config.poolMax).toBe(10);
    });

    it('rejects SYS or SYSTEM as the application runtime user (Least Privilege)', () => {
      expect(() => resolveOracleConfig({ ORACLE_USER: 'SYS' })).toThrow(/administrative user 'SYS' is strictly forbidden/);
      expect(() => resolveOracleConfig({ ORACLE_USER: 'system' })).toThrow(/administrative user 'system' is strictly forbidden/);
    });

    it('validates invalid port numbers', () => {
      expect(() => resolveOracleConfig({ ORACLE_PORT: 'invalid' })).toThrow(/Invalid ORACLE_PORT/);
      expect(() => resolveOracleConfig({ ORACLE_PORT: '-1' })).toThrow(/Invalid ORACLE_PORT/);
      expect(() => resolveOracleConfig({ ORACLE_PORT: '70000' })).toThrow(/Invalid ORACLE_PORT/);
    });
  });

  describe('Lifecycle and connection pooling', () => {
    it('initializes pool and runs healthCheck successfully', async () => {
      const mockConn = {
        execute: vi.fn().mockResolvedValue({ rows: [[1]] }),
        close: vi.fn().mockResolvedValue(undefined)
      };

      const mockPool = {
        getConnection: vi.fn().mockResolvedValue(mockConn),
        close: vi.fn().mockResolvedValue(undefined)
      };

      const mockDriver: OracleDriverInterface = {
        createPool: vi.fn().mockResolvedValue(mockPool as unknown as oracledb.Pool)
      };

      const manager = new OraclePoolManager({}, mockDriver);
      expect(manager.getStatus()).toBe('uninitialized');

      await manager.initialize();
      expect(manager.getStatus()).toBe('healthy');
      expect(mockDriver.createPool).toHaveBeenCalledTimes(1);

      // Test health check
      const hc = await manager.healthCheck();
      expect(hc.ok).toBe(true);
      expect(typeof hc.latencyMs).toBe('number');
      expect(mockConn.execute).toHaveBeenCalledWith('SELECT 1 FROM DUAL');
      expect(mockConn.close).toHaveBeenCalledTimes(1);

      // Test withConnection
      const result = await manager.withConnection(async (conn) => {
        return (await conn.execute('SELECT 1 FROM DUAL')).rows;
      });
      expect(result).toEqual([[1]]);
      expect(mockConn.close).toHaveBeenCalledTimes(2);

      // Test close
      await manager.close();
      expect(manager.getStatus()).toBe('closed');
      expect(mockPool.close).toHaveBeenCalledWith(2);
    });

    it('retries with backoff on transient errors and recovers', async () => {
      const mockPool = {
        getConnection: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined)
      };

      let attempts = 0;
      const mockDriver: OracleDriverInterface = {
        createPool: vi.fn().mockImplementation(async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('ORA-12541: TNS:no listener (starting up)');
          }
          return mockPool as unknown as oracledb.Pool;
        })
      };

      const sleepCalls: number[] = [];
      const fakeSleep = async (ms: number) => {
        sleepCalls.push(ms);
      };

      const manager = new OraclePoolManager(
        { maxRetries: 3, retryInitialDelayMs: 100 },
        mockDriver,
        fakeSleep
      );

      await manager.initialize();
      expect(manager.getStatus()).toBe('healthy');
      expect(mockDriver.createPool).toHaveBeenCalledTimes(2);
      expect(sleepCalls).toEqual([100]);
    });

    it('fails fast when retry limit is exhausted (no infinite loop)', async () => {
      const mockDriver: OracleDriverInterface = {
        createPool: vi.fn().mockRejectedValue(new Error('ORA-12514: TNS:listener does not know service'))
      };

      const sleepCalls: number[] = [];
      const fakeSleep = async (ms: number) => {
        sleepCalls.push(ms);
      };

      const manager = new OraclePoolManager(
        { maxRetries: 3, retryInitialDelayMs: 50 },
        mockDriver,
        fakeSleep
      );

      await expect(manager.initialize()).rejects.toThrow(
        /Failed to initialize Oracle connection pool after 3 attempts/
      );
      expect(manager.getStatus()).toBe('degraded');
      expect(mockDriver.createPool).toHaveBeenCalledTimes(3);
      expect(sleepCalls.length).toBe(2); // Delays before attempt 2 and attempt 3
    });

    it('registers and removes shutdown hooks safely', () => {
      const mockDriver: OracleDriverInterface = {
        createPool: vi.fn()
      };
      const manager = new OraclePoolManager({}, mockDriver);

      const fakeProcess = {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn()
      } as unknown as NodeJS.Process;

      const unregister = manager.registerShutdownHooks(fakeProcess);
      expect(fakeProcess.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(fakeProcess.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));

      unregister();
      expect(fakeProcess.off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(fakeProcess.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });
  });
});

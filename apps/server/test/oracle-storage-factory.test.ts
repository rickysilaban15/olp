import { describe, it, expect, vi } from 'vitest';
import { createStorageBundle } from '../src/oracle/storage-factory.js';
import { OraclePoolManager } from '../src/oracle/oracle-pool.js';
import {
  OracleSiteStore,
  OracleProxyStore,
  OracleSettingsStore,
  OracleCronStore,
  OracleDbRegistry,
  OracleAuthStore
} from '../src/oracle/stores/index.js';

describe('StorageFactory (Explicit Storage State Machine)', () => {
  it('returns JSON storage bundle when OLP_STORAGE_MODE is unset or json', async () => {
    const bundle = await createStorageBundle('/tmp/olp-test-data', { OLP_STORAGE_MODE: 'json' });
    expect(bundle.mode).toBe('json');
    expect(bundle.poolManager).toBeNull();
    expect(bundle.oracleAuthStore).toBeNull();
    expect(bundle.siteStore).toBeDefined();
    expect(bundle.proxyStore).toBeDefined();
    expect(bundle.settingsStore).toBeDefined();
    expect(bundle.cronStore).toBeDefined();
    expect(bundle.dbRegistry).toBeDefined();
  });

  it('initializes Oracle storage bundle when OLP_STORAGE_MODE is oracle', async () => {
    const initSpy = vi.spyOn(OraclePoolManager.prototype, 'initialize').mockResolvedValue(undefined);

    try {
      const bundle = await createStorageBundle('/tmp/olp-test-data', { OLP_STORAGE_MODE: 'oracle' });
      expect(bundle.mode).toBe('oracle');
      expect(bundle.poolManager).toBeInstanceOf(OraclePoolManager);
      expect(bundle.siteStore).toBeInstanceOf(OracleSiteStore);
      expect(bundle.proxyStore).toBeInstanceOf(OracleProxyStore);
      expect(bundle.settingsStore).toBeInstanceOf(OracleSettingsStore);
      expect(bundle.cronStore).toBeInstanceOf(OracleCronStore);
      expect(bundle.dbRegistry).toBeInstanceOf(OracleDbRegistry);
      expect(bundle.oracleAuthStore).toBeInstanceOf(OracleAuthStore);
      expect(initSpy).toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
    }
  });

  it('fails fast and refuses silent fallback to JSON when Oracle initialization fails', async () => {
    const initSpy = vi.spyOn(OraclePoolManager.prototype, 'initialize').mockRejectedValue(
      new Error('ORA-12541: TNS:no listener')
    );

    try {
      await expect(
        createStorageBundle('/tmp/olp-test-data', { OLP_STORAGE_MODE: 'oracle' })
      ).rejects.toThrow(/ORA-12541/);
    } finally {
      initSpy.mockRestore();
    }
  });
});

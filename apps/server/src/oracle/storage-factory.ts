import type { SiteStore } from '../sites.js';
import { fileSiteStore } from '../sites.js';
import type { ProxyStore } from '../proxy.js';
import { fileProxyStore } from '../proxy.js';
import type { SettingsStore } from '../settings.js';
import { fileSettingsStore } from '../settings.js';
import type { RunStore } from '../cron-runs.js';
import { fileRunStore } from '../cron-runs.js';
import type { DbRegistry } from '../database.js';
import { fileRegistry } from '../database.js';
import { OraclePoolManager } from './oracle-pool.js';
import {
  OracleSiteStore,
  OracleProxyStore,
  OracleSettingsStore,
  OracleCronStore,
  OracleDbRegistry,
  OracleAuthStore
} from './stores/index.js';

export type StorageMode = 'json' | 'oracle';

export interface StorageBundle {
  mode: StorageMode;
  poolManager: OraclePoolManager | null;
  siteStore: SiteStore;
  proxyStore: ProxyStore;
  settingsStore: SettingsStore;
  cronStore: RunStore;
  dbRegistry: DbRegistry;
  oracleAuthStore: OracleAuthStore | null;
}

/**
 * Menyelesaikan bundel penyimpanan OLP berdasarkan mode konfigurasi.
 *
 * Kebijakan Integritas Data (Zero Silent Fallback):
 * - Jika OLP_STORAGE_MODE disetel ke 'oracle', OLP HANYA menggunakan Oracle Database.
 * - Jika koneksi Oracle gagal, OLP DILARANG KERAS berpindah secara diam-diam ke file JSON lama,
 *   karena file JSON lama sudah usang (stale) dan akan menyebabkan data split-brain atau data hilang.
 */
export async function createStorageBundle(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  masterKey?: Buffer
): Promise<StorageBundle> {
  const mode: StorageMode = (env['OLP_STORAGE_MODE']?.trim().toLowerCase() === 'oracle') ? 'oracle' : 'json';

  if (mode === 'json') {
    return {
      mode: 'json',
      poolManager: null,
      siteStore: fileSiteStore(dataDir),
      proxyStore: fileProxyStore(dataDir),
      settingsStore: fileSettingsStore(dataDir),
      cronStore: fileRunStore(dataDir),
      dbRegistry: fileRegistry(dataDir),
      oracleAuthStore: null
    };
  }

  // Mode Oracle
  const poolManager = new OraclePoolManager(undefined, undefined, undefined, env);
  await poolManager.initialize();

  return {
    mode: 'oracle',
    poolManager,
    siteStore: new OracleSiteStore(poolManager),
    proxyStore: new OracleProxyStore(poolManager),
    settingsStore: new OracleSettingsStore(poolManager, masterKey),
    cronStore: new OracleCronStore(poolManager),
    dbRegistry: new OracleDbRegistry(poolManager, masterKey),
    oracleAuthStore: new OracleAuthStore(poolManager)
  };
}

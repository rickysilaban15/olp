import type { OraclePoolManager } from './oracle-pool.js';
import { OracleSiteStore, OracleProxyStore, OracleSettingsStore, OracleDbRegistry, OracleAuthStore } from './stores/index.js';
import type { AuthConfig } from '@olp/auth';
import type { Site } from '../sites.js';
import type { Proxy } from '../proxy.js';
import type { Settings } from '../settings.js';
import type { DbConfig } from '../database.js';

export interface BundleConfigDump {
  auth?: AuthConfig | null;
  sites: Site[];
  nginx: Proxy[];
  settings: Settings;
  db: Partial<Record<'mysql' | 'postgres', DbConfig>>;
}

export interface RestoreReport {
  success: boolean;
  restoredAuth: boolean;
  restoredSitesCount: number;
  restoredProxiesCount: number;
  restoredSettings: boolean;
  restoredDatabasesCount: number;
  error?: string;
}

export class OracleBackupManager {
  private poolManager: OraclePoolManager;
  private siteStore: OracleSiteStore;
  private proxyStore: OracleProxyStore;
  private settingsStore: OracleSettingsStore;
  private dbRegistry: OracleDbRegistry;
  private authStore: OracleAuthStore;

  constructor(poolManager: OraclePoolManager, masterKey?: Buffer) {
    this.poolManager = poolManager;
    this.siteStore = new OracleSiteStore(poolManager);
    this.proxyStore = new OracleProxyStore(poolManager);
    this.settingsStore = new OracleSettingsStore(poolManager, masterKey);
    this.dbRegistry = new OracleDbRegistry(poolManager, masterKey);
    this.authStore = new OracleAuthStore(poolManager);
  }

  /**
   * Mengekstrak seluruh data internal Oracle ke dalam format bundle konfigurasi OLP.
   * Format ini 100% kompatibel dengan bundle snapshot OLP yang sudah ada.
   */
  public async exportBundleConfigs(): Promise<BundleConfigDump> {
    const [auth, sites, nginx, settings, db] = await Promise.all([
      this.authStore.loadConfig(),
      this.siteStore.list(),
      this.proxyStore.list(),
      this.settingsStore.load(),
      this.dbRegistry.load()
    ]);

    return {
      auth,
      sites,
      nginx,
      settings,
      db
    };
  }

  /**
   * Memulihkan data dari bundle konfigurasi ke dalam tabel-tabel Oracle secara transaksional utuh (single transaction).
   *
   * Catatan Integritas Transaksi:
   * Seluruh operasi pemulihan data OLP menggunakan DML murni (DELETE, INSERT, MERGE),
   * sehingga mendukung atomisitas ACID penuh. Jika ada entitas yang gagal dipulihkan,
   * pemulihan memanggil conn.rollback() sehingga tidak ada data yang tertinggal dalam kondisi parsial.
   * DDL sama sekali tidak digunakan dalam proses pemulihan data ini.
   */
  public async restoreBundleConfigs(
    dump: BundleConfigDump,
    operatorId: string = 'current_admin'
  ): Promise<RestoreReport> {
    const report: RestoreReport = {
      success: false,
      restoredAuth: false,
      restoredSitesCount: 0,
      restoredProxiesCount: 0,
      restoredSettings: false,
      restoredDatabasesCount: 0
    };

    try {
      await this.poolManager.withConnection(async (conn) => {
        try {
          // 1. Pulihkan Sites
          if (Array.isArray(dump.sites)) {
            await this.siteStore.saveWithConnection(conn, dump.sites);
            report.restoredSitesCount = dump.sites.length;
          }

          // 2. Pulihkan Proxies
          if (Array.isArray(dump.nginx)) {
            await this.proxyStore.saveWithConnection(conn, dump.nginx);
            report.restoredProxiesCount = dump.nginx.length;
          }

          // 3. Pulihkan Settings
          if (dump.settings) {
            await this.settingsStore.saveWithConnection(conn, dump.settings);
            report.restoredSettings = true;
          }

          // 4. Pulihkan Databases
          if (dump.db) {
            await this.dbRegistry.saveWithConnection(conn, dump.db);
            report.restoredDatabasesCount = Object.keys(dump.db).length;
          }

          // 5. Pulihkan Auth (kredensial operator & passkey) jika bundle membawanya
          if (dump.auth) {
            await this.authStore.saveConfigWithConnection(conn, dump.auth, operatorId);
            report.restoredAuth = true;
          }

          // Commit atomik setelah semua operasi DML berhasil
          await conn.commit();
          report.success = true;
        } catch (innerErr) {
          // Rollback transaksional penuh jika salah satu entitas gagal
          await conn.rollback().catch(() => '');
          throw innerErr;
        }
      });
    } catch (err: unknown) {
      report.success = false;
      report.error = err instanceof Error ? err.message : String(err);
    }

    return report;
  }
}

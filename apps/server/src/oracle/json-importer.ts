import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OraclePoolManager } from './oracle-pool.js';
import { encryptSecret, resolveMasterKey } from './crypto-secrets.js';
import type { AuthConfig, PasskeyCredential } from '@olp/auth';
import type { Site } from '../sites.js';
import type { Proxy } from '../proxy.js';
import type { Settings } from '../settings.js';
import type { RunRecord } from '../cron-runs.js';
import type { DbConfig } from '../database.js';
import type { BackupSchedule, BackupMeta, BundleManifest } from '../backup.js';

export interface EntityImportReport {
  entity: string;
  sourceFile: string;
  sourceFound: boolean;
  sourceRecords: number;
  importedRecords: number;
  skippedRecords: number;
  failedRecords: number;
  validationPassed: boolean;
  error?: string;
}

export interface FullImportReport {
  timestamp: string;
  overallSuccess: boolean;
  reports: EntityImportReport[];
}

export class JsonImporter {
  private poolManager: OraclePoolManager;
  private dataDir: string;
  private masterKey: Buffer;

  constructor(poolManager: OraclePoolManager, dataDir: string, masterKey?: Buffer) {
    this.poolManager = poolManager;
    this.dataDir = dataDir;
    this.masterKey = masterKey ?? resolveMasterKey();
  }

  /**
   * Menjalankan import seluruh file JSON internal OLP ke tabel Oracle secara idempotent.
   * File JSON sumber sama sekali TIDAK diubah atau dihapus.
   */
  public async importAll(): Promise<FullImportReport> {
    const reports: EntityImportReport[] = [];

    reports.push(await this.importAuth());
    reports.push(await this.importSites());
    reports.push(await this.importProxies());
    reports.push(await this.importSettings());
    reports.push(await this.importCronRuns());
    reports.push(await this.importDatabases());
    reports.push(await this.importBackupSchedules());
    reports.push(await this.importBackupMetadata());

    const overallSuccess = reports.every((r) => !r.sourceFound || (r.failedRecords === 0 && r.validationPassed));

    return {
      timestamp: new Date().toISOString(),
      overallSuccess,
      reports
    };
  }

  public async importAuth(): Promise<EntityImportReport> {
    const file = join(this.dataDir, 'config.json');
    const report: EntityImportReport = {
      entity: 'auth',
      sourceFile: file,
      sourceFound: false,
      sourceRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      validationPassed: false
    };

    if (!existsSync(file)) {
      report.validationPassed = true;
      return report;
    }
    report.sourceFound = true;

    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as AuthConfig;
      if (!raw || typeof raw.username !== 'string' || !raw.hash || !raw.salt) {
        report.failedRecords = 1;
        report.error = 'Invalid auth config structure';
        return report;
      }

      report.sourceRecords = 1 + (Array.isArray(raw.passkeys) ? raw.passkeys.length : 0);

      await this.poolManager.withConnection(async (conn) => {
        // 1. Simpan operator admin
        await conn.execute(
          `MERGE INTO olp_operator dst
           USING (SELECT 'current_admin' AS operator_id FROM dual) src
           ON (dst.operator_id = src.operator_id)
           WHEN MATCHED THEN
             UPDATE SET username = :username, password_salt = :salt, password_hash = :hash, updated_at = CURRENT_TIMESTAMP
           WHEN NOT MATCHED THEN
             INSERT (operator_id, username, password_salt, password_hash)
             VALUES ('current_admin', :username, :salt, :hash)`,
          { username: raw.username, salt: raw.salt, hash: raw.hash }
        );
        report.importedRecords++;

        // 2. Simpan passkey
        if (Array.isArray(raw.passkeys)) {
          for (const pk of raw.passkeys as PasskeyCredential[]) {
            if (!pk.id || !pk.publicKey) {
              report.skippedRecords++;
              continue;
            }
            await conn.execute(
              `MERGE INTO olp_passkeys dst
               USING (SELECT :id AS credential_id FROM dual) src
               ON (dst.credential_id = src.credential_id)
               WHEN MATCHED THEN
                 UPDATE SET counter = :counter, name = :name
               WHEN NOT MATCHED THEN
                 INSERT (credential_id, operator_id, public_key, counter, name, created_at_epoch)
                 VALUES (:id, 'current_admin', :pubKey, :counter, :name, :created)`,
              {
                id: pk.id,
                pubKey: pk.publicKey,
                counter: pk.counter || 0,
                name: pk.name || '',
                created: pk.created || Date.now()
              }
            );
            report.importedRecords++;
          }
        }
        await conn.commit();

        // 3. Validasi
        const check = await conn.execute(`SELECT COUNT(*) FROM olp_operator WHERE operator_id = 'current_admin'`);
        const count = Number((check.rows?.[0] as unknown[])?.[0] || 0);
        report.validationPassed = count === 1;
      });
    } catch (err: unknown) {
      report.failedRecords = 1;
      report.error = err instanceof Error ? err.message : String(err);
    }

    return report;
  }

  public async importSites(): Promise<EntityImportReport> {
    const file = join(this.dataDir, 'sites.json');
    const report: EntityImportReport = {
      entity: 'sites',
      sourceFile: file,
      sourceFound: false,
      sourceRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      validationPassed: false
    };

    if (!existsSync(file)) {
      report.validationPassed = true;
      return report;
    }
    report.sourceFound = true;

    try {
      const sites = JSON.parse(readFileSync(file, 'utf8')) as Site[];
      if (!Array.isArray(sites)) {
        report.failedRecords = 1;
        report.error = 'sites.json does not contain an array';
        return report;
      }

      report.sourceRecords = sites.length;

      await this.poolManager.withConnection(async (conn) => {
        for (const s of sites) {
          if (!s.id || !s.name || !s.port) {
            report.skippedRecords++;
            continue;
          }
          await conn.execute(
            `MERGE INTO olp_sites dst
             USING (SELECT :id AS site_id FROM dual) src
             ON (dst.site_id = src.site_id)
             WHEN MATCHED THEN
               UPDATE SET name = :name, site_type = :stype, root_path = :rpath, port = :port
             WHEN NOT MATCHED THEN
               INSERT (site_id, name, site_type, root_path, port, created_at_epoch)
               VALUES (:id, :name, :stype, :rpath, :port, :created)`,
            {
              id: s.id,
              name: s.name,
              stype: s.type,
              rpath: s.path,
              port: s.port,
              created: s.created || Date.now()
            }
          );
          report.importedRecords++;
        }
        await conn.commit();

        const check = await conn.execute(`SELECT COUNT(*) FROM olp_sites`);
        const count = Number((check.rows?.[0] as unknown[])?.[0] || 0);
        report.validationPassed = count >= report.importedRecords;
      });
    } catch (err: unknown) {
      report.failedRecords = 1;
      report.error = err instanceof Error ? err.message : String(err);
    }

    return report;
  }

  public async importProxies(): Promise<EntityImportReport> {
    const file = join(this.dataDir, 'nginx.json');
    const report: EntityImportReport = {
      entity: 'proxies',
      sourceFile: file,
      sourceFound: false,
      sourceRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      validationPassed: false
    };

    if (!existsSync(file)) {
      report.validationPassed = true;
      return report;
    }
    report.sourceFound = true;

    try {
      const proxies = JSON.parse(readFileSync(file, 'utf8')) as Proxy[];
      if (!Array.isArray(proxies)) {
        report.failedRecords = 1;
        report.error = 'nginx.json does not contain an array';
        return report;
      }

      report.sourceRecords = proxies.length;

      await this.poolManager.withConnection(async (conn) => {
        for (const p of proxies) {
          if (!p.id || !p.listenPort || !p.domain) {
            report.skippedRecords++;
            continue;
          }
          await conn.execute(
            `MERGE INTO olp_proxies dst
             USING (SELECT :id AS proxy_id FROM dual) src
             ON (dst.proxy_id = src.proxy_id)
             WHEN MATCHED THEN
               UPDATE SET name = :name, listen_port = :lport, domain = :domain, target_port = :tport
             WHEN NOT MATCHED THEN
               INSERT (proxy_id, name, listen_port, domain, target_port, created_at_epoch)
               VALUES (:id, :name, :lport, :domain, :tport, :created)`,
            {
              id: p.id,
              name: p.name,
              lport: p.listenPort,
              domain: p.domain,
              tport: p.targetPort,
              created: p.created || Date.now()
            }
          );
          report.importedRecords++;
        }
        await conn.commit();

        const check = await conn.execute(`SELECT COUNT(*) FROM olp_proxies`);
        const count = Number((check.rows?.[0] as unknown[])?.[0] || 0);
        report.validationPassed = count >= report.importedRecords;
      });
    } catch (err: unknown) {
      report.failedRecords = 1;
      report.error = err instanceof Error ? err.message : String(err);
    }

    return report;
  }

  public async importSettings(): Promise<EntityImportReport> {
    const file = join(this.dataDir, 'settings.json');
    const report: EntityImportReport = {
      entity: 'settings',
      sourceFile: file,
      sourceFound: false,
      sourceRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      validationPassed: false
    };

    if (!existsSync(file)) {
      report.validationPassed = true;
      return report;
    }
    report.sourceFound = true;

    try {
      const settings = JSON.parse(readFileSync(file, 'utf8')) as Settings;
      report.sourceRecords = 1;

      await this.poolManager.withConnection(async (conn) => {
        let encryptedToken: string | null = null;
        if (settings.telegram?.botToken && settings.telegram.botToken.trim() !== '') {
          encryptedToken = encryptSecret(settings.telegram.botToken, this.masterKey);
        }

        const bindHost = settings.bind?.host ?? null;
        const bindPort = settings.bind?.port ?? null;

        await conn.execute(
          `MERGE INTO olp_settings dst
           USING (SELECT 'global' AS setting_key FROM dual) src
           ON (dst.setting_key = src.setting_key)
           WHEN MATCHED THEN
             UPDATE SET telegram_bot_token_encrypted = :token,
                        telegram_chat_id = :chatId,
                        telegram_enabled = :enabled,
                        telegram_commands_enabled = :cmdEnabled,
                        bind_host = :bindHost,
                        bind_port = :bindPort,
                        updated_at = CURRENT_TIMESTAMP
           WHEN NOT MATCHED THEN
             INSERT (setting_key, telegram_bot_token_encrypted, telegram_chat_id, telegram_enabled,
                     telegram_commands_enabled, bind_host, bind_port)
             VALUES ('global', :token, :chatId, :enabled, :cmdEnabled, :bindHost, :bindPort)`,
          {
            token: encryptedToken,
            chatId: settings.telegram?.chatId ?? '',
            enabled: settings.telegram?.enabled ? 1 : 0,
            cmdEnabled: settings.telegram?.commandsEnabled ? 1 : 0,
            bindHost,
            bindPort
          }
        );
        await conn.commit();

        report.importedRecords = 1;
        report.validationPassed = true;
      });
    } catch (err: unknown) {
      report.failedRecords = 1;
      report.error = err instanceof Error ? err.message : String(err);
    }

    return report;
  }

  public async importCronRuns(): Promise<EntityImportReport> {
    const file = join(this.dataDir, 'cron-runs.json');
    const report: EntityImportReport = {
      entity: 'cron_runs',
      sourceFile: file,
      sourceFound: false,
      sourceRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      validationPassed: false
    };

    if (!existsSync(file)) {
      report.validationPassed = true;
      return report;
    }
    report.sourceFound = true;

    try {
      const runs = JSON.parse(readFileSync(file, 'utf8')) as RunRecord[];
      if (!Array.isArray(runs)) {
        report.failedRecords = 1;
        report.error = 'cron-runs.json does not contain an array';
        return report;
      }

      report.sourceRecords = runs.length;

      await this.poolManager.withConnection(async (conn) => {
        for (const r of runs) {
          if (!r.id || !r.jobId) {
            report.skippedRecords++;
            continue;
          }
          await conn.execute(
            `MERGE INTO olp_cron_runs dst
             USING (SELECT :id AS run_id FROM dual) src
             ON (dst.run_id = src.run_id)
             WHEN NOT MATCHED THEN
               INSERT (run_id, job_id, name, command, started_at_epoch, finished_at_epoch,
                       exit_code, timed_out, latency_ms, output)
               VALUES (:id, :jobId, :name, :command, :startedAt, :finishedAt,
                       :exitCode, :timedOut, :latencyMs, :output)`,
            {
              id: r.id,
              jobId: r.jobId,
              name: r.name || '',
              command: r.command || '',
              startedAt: r.startedAt || 0,
              finishedAt: r.finishedAt || 0,
              exitCode: r.exitCode ?? null,
              timedOut: r.timedOut ? 1 : 0,
              latencyMs: r.latencyMs || 0,
              output: r.output || ''
            }
          );
          report.importedRecords++;
        }
        await conn.commit();
        report.validationPassed = true;
      });
    } catch (err: unknown) {
      report.failedRecords = 1;
      report.error = err instanceof Error ? err.message : String(err);
    }

    return report;
  }

  public async importDatabases(): Promise<EntityImportReport> {
    const file = join(this.dataDir, 'db.json');
    const report: EntityImportReport = {
      entity: 'databases',
      sourceFile: file,
      sourceFound: false,
      sourceRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      validationPassed: false
    };

    if (!existsSync(file)) {
      report.validationPassed = true;
      return report;
    }
    report.sourceFound = true;

    try {
      const dbs = JSON.parse(readFileSync(file, 'utf8')) as Record<string, DbConfig>;
      const entries = Object.entries(dbs);
      report.sourceRecords = entries.length;

      await this.poolManager.withConnection(async (conn) => {
        for (const [engine, cfg] of entries) {
          if (!cfg || !cfg.host) {
            report.skippedRecords++;
            continue;
          }
          const encryptedPwd = cfg.password ? encryptSecret(cfg.password, this.masterKey) : '';
          await conn.execute(
            `MERGE INTO olp_db_connections dst
             USING (SELECT :eng AS engine, 1 AS is_default FROM dual) src
             ON (dst.engine = src.engine AND dst.is_default = src.is_default)
             WHEN MATCHED THEN
               UPDATE SET name = :name, host = :host, port = :port, db_user = :dbUser,
                          password_encrypted = :pwd, database_name = :db, updated_at = CURRENT_TIMESTAMP
             WHEN NOT MATCHED THEN
               INSERT (connection_id, name, engine, host, port, db_user, password_encrypted, database_name, is_default)
               VALUES (:id, :name, :eng, :host, :port, :dbUser, :pwd, :db, 1)`,
            {
              id: `imported-${engine}`,
              name: `Imported ${engine.toUpperCase()} Connection`,
              eng: engine,
              host: cfg.host,
              port: cfg.port || (engine === 'mysql' ? 3306 : 5432),
              dbUser: cfg.user || '',
              pwd: encryptedPwd,
              db: cfg.database || ''
            }
          );
          report.importedRecords++;
        }
        await conn.commit();
        report.validationPassed = true;
      });
    } catch (err: unknown) {
      report.failedRecords = 1;
      report.error = err instanceof Error ? err.message : String(err);
    }

    return report;
  }

  public async importBackupSchedules(): Promise<EntityImportReport> {
    const file = join(this.dataDir, 'backups', 'backup-schedules.json');
    const report: EntityImportReport = {
      entity: 'backup_schedules',
      sourceFile: file,
      sourceFound: false,
      sourceRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      validationPassed: false
    };

    if (!existsSync(file)) {
      report.validationPassed = true;
      return report;
    }
    report.sourceFound = true;

    try {
      const schedules = JSON.parse(readFileSync(file, 'utf8')) as BackupSchedule[];
      if (!Array.isArray(schedules)) {
        report.failedRecords = 1;
        report.error = 'backup-schedules.json does not contain an array';
        return report;
      }

      report.sourceRecords = schedules.length;

      await this.poolManager.withConnection(async (conn) => {
        for (const s of schedules) {
          if (!s.id || !s.name) {
            report.skippedRecords++;
            continue;
          }
          await conn.execute(
            `MERGE INTO olp_backup_schedules dst
             USING (SELECT :id AS schedule_id FROM dual) src
             ON (dst.schedule_id = src.schedule_id)
             WHEN MATCHED THEN
               UPDATE SET name = :name, backup_type = :btype, source_target = :source,
                          cron_expression = :cron, enabled = :enabled, last_run_epoch = :lastRun,
                          last_status = :lastStatus
             WHEN NOT MATCHED THEN
               INSERT (schedule_id, name, backup_type, source_target, cron_expression, enabled,
                       created_at_epoch, last_run_epoch, last_status)
               VALUES (:id, :name, :btype, :source, :cron, :enabled, :created, :lastRun, :lastStatus)`,
            {
              id: s.id,
              name: s.name,
              btype: s.type,
              source: s.source,
              cron: s.schedule,
              enabled: s.enabled ? 1 : 0,
              created: s.created || Date.now(),
              lastRun: s.lastRun ?? null,
              lastStatus: s.lastStatus ?? null
            }
          );
          report.importedRecords++;
        }
        await conn.commit();
        report.validationPassed = true;
      });
    } catch (err: unknown) {
      report.failedRecords = 1;
      report.error = err instanceof Error ? err.message : String(err);
    }

    return report;
  }

  public async importBackupMetadata(): Promise<EntityImportReport> {
    const backupsDir = join(this.dataDir, 'backups');
    const report: EntityImportReport = {
      entity: 'backup_metadata',
      sourceFile: backupsDir,
      sourceFound: false,
      sourceRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      validationPassed: true
    };

    if (!existsSync(backupsDir)) {
      report.validationPassed = true;
      return report;
    }
    report.sourceFound = true;

    try {
      const files = readdirSync(backupsDir);
      const sidecarFiles = files.filter((f) => f.endsWith('.json') && !f.endsWith('.bundle.json') && f !== 'backup-schedules.json');
      const bundleFiles = files.filter((f) => f.endsWith('.bundle.json'));

      report.sourceRecords = sidecarFiles.length + bundleFiles.length;

      await this.poolManager.withConnection(async (conn) => {
        // 1. Import sidecar metadata
        for (const sf of sidecarFiles) {
          try {
            const meta = JSON.parse(readFileSync(join(backupsDir, sf), 'utf8')) as BackupMeta;
            if (!meta.name || !meta.file) continue;
            await conn.execute(
              `MERGE INTO olp_backup_metadata dst
               USING (SELECT :name AS backup_name FROM dual) src
               ON (dst.backup_name = src.backup_name)
               WHEN MATCHED THEN
                 UPDATE SET filename = :file, backup_type = :btype, source_target = :source, sha256_checksum = :sha
               WHEN NOT MATCHED THEN
                 INSERT (backup_name, filename, backup_type, source_target, sha256_checksum, file_size_bytes, created_at_epoch)
                 VALUES (:name, :file, :btype, :source, :sha, 0, :created)`,
              {
                name: meta.name,
                file: meta.file,
                btype: meta.type,
                source: meta.source,
                sha: meta.sha256 ?? null,
                created: meta.created || Date.now()
              }
            );
            report.importedRecords++;
          } catch {
            report.skippedRecords++;
          }
        }

        // 2. Import bundle manifests
        for (const bf of bundleFiles) {
          try {
            const manifest = JSON.parse(readFileSync(join(backupsDir, bf), 'utf8')) as BundleManifest;
            if (!manifest.id || !Array.isArray(manifest.parts)) continue;
            await conn.execute(
              `MERGE INTO olp_backup_bundles dst
               USING (SELECT :id AS bundle_id FROM dual) src
               ON (dst.bundle_id = src.bundle_id)
               WHEN NOT MATCHED THEN
                 INSERT (bundle_id, has_auth, created_at_epoch)
                 VALUES (:id, :hasAuth, :created)`,
              {
                id: manifest.id,
                hasAuth: manifest.hasAuth ? 1 : 0,
                created: manifest.created || Date.now()
              }
            );
            report.importedRecords++;

            for (const part of manifest.parts) {
              await conn.execute(
                `MERGE INTO olp_backup_bundle_parts dst
                 USING (SELECT :pid AS part_id FROM dual) src
                 ON (dst.part_id = src.part_id)
                 WHEN NOT MATCHED THEN
                   INSERT (part_id, bundle_id, part_name, part_kind, filename, sha256_checksum)
                   VALUES (:pid, :bid, :pname, :pkind, :fname, :sha)`,
                {
                  pid: `${manifest.id}-${part.name}`,
                  bid: manifest.id,
                  pname: part.name,
                  pkind: part.kind,
                  fname: part.file,
                  sha: part.sha256
                }
              );
              report.importedRecords++;
            }
          } catch {
            report.skippedRecords++;
          }
        }

        await conn.commit();
      });
    } catch (err: unknown) {
      report.failedRecords = 1;
      report.error = err instanceof Error ? err.message : String(err);
      report.validationPassed = false;
    }

    return report;
  }
}

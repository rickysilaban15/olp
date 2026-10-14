import type oracledb from 'oracledb';
import type { DbConfig, DbRegistry } from '../../database.js';
import type { OraclePoolManager } from '../oracle-pool.js';
import { encryptSecret, decryptSecret, resolveMasterKey } from '../crypto-secrets.js';

export type SupportedEngine = 'mysql' | 'postgres' | 'oracle';

export interface DbConnectionRecord {
  id: string;
  name: string;
  engine: SupportedEngine;
  host: string;
  port: number;
  user: string;
  passwordEncrypted: string;
  database: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class OracleDbRegistry implements DbRegistry {
  private poolManager: OraclePoolManager;
  private masterKey?: Buffer;

  constructor(poolManager: OraclePoolManager, masterKey?: Buffer) {
    this.poolManager = poolManager;
    this.masterKey = masterKey;
  }

  private getKey(): Buffer {
    if (this.masterKey) return this.masterKey;
    return resolveMasterKey();
  }

  public async load(): Promise<Partial<Record<'mysql' | 'postgres', DbConfig>>> {
    return this.poolManager.withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT connection_id, name, engine, host, port, db_user, password_encrypted, database_name, is_default
         FROM olp_db_connections
         WHERE is_default = 1`
      );

      const out: Partial<Record<'mysql' | 'postgres', DbConfig>> = {};
      if (!result.rows || !Array.isArray(result.rows)) {
        return out;
      }

      for (const row of result.rows as unknown[][]) {
        const [, , engine, host, port, dbUser, encryptedPwd, dbName] = row;
        const eng = String(engine) as 'mysql' | 'postgres';
        if (eng !== 'mysql' && eng !== 'postgres') continue;

        let password = '';
        if (encryptedPwd && typeof encryptedPwd === 'string' && encryptedPwd.trim() !== '') {
          try {
            password = decryptSecret(encryptedPwd, this.getKey());
          } catch {
            password = '';
          }
        }

        out[eng] = {
          host: String(host),
          port: Number(port),
          user: String(dbUser),
          password,
          database: String(dbName || '')
        };
      }

      return out;
    });
  }

  public async saveWithConnection(conn: oracledb.Connection, cfgs: Partial<Record<'mysql' | 'postgres', DbConfig>>): Promise<void> {
    for (const [engine, cfg] of Object.entries(cfgs)) {
      if (!cfg) continue;
      const encryptedPwd = cfg.password ? encryptSecret(cfg.password, this.getKey()) : '';

      // Simpan sebagai default connection untuk engine tersebut
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
          id: `default-${engine}`,
          name: `Default ${engine.toUpperCase()} Connection`,
          eng: engine,
          host: cfg.host,
          port: cfg.port,
          dbUser: cfg.user,
          pwd: encryptedPwd,
          db: cfg.database
        }
      );
    }
  }

  public async save(cfgs: Partial<Record<'mysql' | 'postgres', DbConfig>>): Promise<void> {
    return this.poolManager.withConnection(async (conn) => {
      await this.saveWithConnection(conn, cfgs);
      await conn.commit();
    });
  }
}

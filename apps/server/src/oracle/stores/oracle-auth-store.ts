import type oracledb from 'oracledb';
import type { AuthConfig, PasskeyCredential } from '@olp/auth';
import type { OraclePoolManager } from '../oracle-pool.js';

export class OracleAuthStore {
  private poolManager: OraclePoolManager;

  constructor(poolManager: OraclePoolManager) {
    this.poolManager = poolManager;
  }

  public async loadConfig(operatorId?: string): Promise<AuthConfig | null> {
    return this.poolManager.withConnection(async (conn) => {
      // 1. Ambil data operator (admin)
      const opResult = operatorId
        ? await conn.execute(
            `SELECT operator_id, username, password_salt, password_hash
             FROM olp_operator
             WHERE operator_id = :opId`,
            { opId: operatorId }
          )
        : await conn.execute(
            `SELECT operator_id, username, password_salt, password_hash
             FROM olp_operator
             ORDER BY updated_at DESC
             FETCH FIRST 1 ROWS ONLY`
          );

      if (!opResult.rows || opResult.rows.length === 0) {
        return null;
      }

      const [actualOperatorId, username, salt, hash] = (opResult.rows[0] as unknown[]);

      // 2. Ambil passkey yang terikat pada operator ini
      const passkeyResult = await conn.execute(
        `SELECT credential_id, public_key, counter, name, created_at_epoch
         FROM olp_passkeys
         WHERE operator_id = :opId
         ORDER BY created_at_epoch ASC`,
        { opId: String(actualOperatorId) }
      );

      const passkeys: PasskeyCredential[] = [];
      if (passkeyResult.rows && Array.isArray(passkeyResult.rows)) {
        for (const row of passkeyResult.rows as unknown[][]) {
          const [id, publicKey, counter, name, created] = row;
          passkeys.push({
            id: String(id),
            publicKey: String(publicKey),
            counter: Number(counter),
            name: String(name),
            created: Number(created)
          });
        }
      }

      return {
        username: String(username),
        salt: String(salt),
        hash: String(hash),
        passkeys
      };
    });
  }

  public async saveConfigWithConnection(
    conn: oracledb.Connection,
    config: AuthConfig,
    operatorId: string = 'current_admin'
  ): Promise<void> {
    // 1. Simpan atau perbarui akun operator (merge berdasarkan username unik)
    await conn.execute(
      `MERGE INTO olp_operator dst
       USING (
         SELECT :opId AS operator_id, :username AS username, :salt AS password_salt, :hash AS password_hash FROM dual
       ) src
       ON (dst.username = src.username)
       WHEN MATCHED THEN
         UPDATE SET password_salt = src.password_salt, password_hash = src.password_hash, updated_at = CURRENT_TIMESTAMP
       WHEN NOT MATCHED THEN
         INSERT (operator_id, username, password_salt, password_hash)
         VALUES (src.operator_id, src.username, src.password_salt, src.password_hash)`,
      {
        opId: operatorId,
        username: config.username,
        salt: config.salt,
        hash: config.hash
      }
    );

    // Ambil operator_id yang sebenarnya dari basis data
    const opResult = await conn.execute(
      `SELECT operator_id FROM olp_operator WHERE username = :username`,
      { username: config.username }
    );
    const resolvedOpId = (opResult.rows && opResult.rows.length > 0)
      ? String((opResult.rows[0] as unknown[])[0])
      : operatorId;

    // 2. Sinkronisasi passkey
    if (!config.passkeys || config.passkeys.length === 0) {
      await conn.execute(
        `DELETE FROM olp_passkeys WHERE operator_id = :opId`,
        { opId: resolvedOpId }
      );
    } else {
      const currentIds = config.passkeys.map((p) => p.id);
      const placeholders = currentIds.map((_, i) => `:id${i}`).join(', ');
      const bindParams: Record<string, string | number> = { opId: resolvedOpId };
      currentIds.forEach((id, i) => {
        bindParams[`id${i}`] = id;
      });

      // Hapus passkey yang dicabut
      await conn.execute(
        `DELETE FROM olp_passkeys
         WHERE operator_id = :opId AND credential_id NOT IN (${placeholders})`,
        bindParams
      );

      // Tambah atau perbarui passkey
      for (const pk of config.passkeys) {
        await conn.execute(
          `MERGE INTO olp_passkeys dst
           USING (SELECT :credId AS credential_id FROM dual) src
           ON (dst.credential_id = src.credential_id)
           WHEN MATCHED THEN
             UPDATE SET counter = :counter, name = :name
           WHEN NOT MATCHED THEN
             INSERT (credential_id, operator_id, public_key, counter, name, created_at_epoch)
             VALUES (:credId, :opId, :pubKey, :counter, :name, :created)`,
          {
            credId: pk.id,
            opId: resolvedOpId,
            pubKey: pk.publicKey,
            counter: pk.counter,
            name: pk.name,
            created: pk.created
          }
        );
      }
    }
  }

  public async saveConfig(config: AuthConfig, operatorId: string = 'current_admin'): Promise<void> {
    return this.poolManager.withConnection(async (conn) => {
      await this.saveConfigWithConnection(conn, config, operatorId);
      await conn.commit();
    });
  }
}

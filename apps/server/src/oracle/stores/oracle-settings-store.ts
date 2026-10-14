import type oracledb from 'oracledb';
import type { Settings, SettingsStore, BindFile } from '../../settings.js';
import { defaultSettings } from '../../settings.js';
import type { OraclePoolManager } from '../oracle-pool.js';
import { encryptSecret, decryptSecret, resolveMasterKey } from '../crypto-secrets.js';

export class OracleSettingsStore implements SettingsStore {
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

  public async load(): Promise<Settings> {
    return this.poolManager.withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT telegram_bot_token_encrypted, telegram_chat_id, telegram_enabled,
                telegram_commands_enabled, bind_host, bind_port
         FROM olp_settings
         WHERE setting_key = 'global'`
      );

      if (!result.rows || result.rows.length === 0) {
        return defaultSettings();
      }

      const row = (result.rows[0] as unknown[]);
      const [encryptedToken, chatId, enabled, commandsEnabled, bindHost, bindPort] = row;

      let botToken = '';
      if (encryptedToken && typeof encryptedToken === 'string' && encryptedToken.trim() !== '') {
        try {
          botToken = decryptSecret(encryptedToken, this.getKey());
        } catch {
          // Jika dekripsi gagal (misal kunci berbeda), jangan crash load
          botToken = '';
        }
      }

      let bind: BindFile | null = null;
      if (bindHost && bindPort) {
        bind = {
          host: String(bindHost),
          port: Number(bindPort)
        };
      }

      return {
        telegram: {
          botToken,
          chatId: chatId ? String(chatId) : '',
          enabled: Boolean(enabled),
          commandsEnabled: Boolean(commandsEnabled)
        },
        bind
      };
    });
  }

  public async saveWithConnection(conn: oracledb.Connection, settings: Settings): Promise<void> {
    let encryptedToken: string | null = null;
    if (settings.telegram.botToken && settings.telegram.botToken.trim() !== '') {
      encryptedToken = encryptSecret(settings.telegram.botToken, this.getKey());
    }

    const bindHost = settings.bind ? settings.bind.host : null;
    const bindPort = settings.bind ? settings.bind.port : null;

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
        chatId: settings.telegram.chatId || '',
        enabled: settings.telegram.enabled ? 1 : 0,
        cmdEnabled: settings.telegram.commandsEnabled ? 1 : 0,
        bindHost,
        bindPort
      }
    );
  }

  public async save(settings: Settings): Promise<void> {
    return this.poolManager.withConnection(async (conn) => {
      await this.saveWithConnection(conn, settings);
      await conn.commit();
    });
  }
}

import type oracledb from 'oracledb';
import type { Proxy, ProxyStore } from '../../proxy.js';
import type { OraclePoolManager } from '../oracle-pool.js';

export class OracleProxyStore implements ProxyStore {
  private poolManager: OraclePoolManager;

  constructor(poolManager: OraclePoolManager) {
    this.poolManager = poolManager;
  }

  public async list(): Promise<Proxy[]> {
    return this.poolManager.withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT proxy_id, name, listen_port, domain, target_port, created_at_epoch
         FROM olp_proxies
         ORDER BY created_at_epoch ASC`
      );

      if (!result.rows || !Array.isArray(result.rows)) {
        return [];
      }

      return (result.rows as unknown[][]).map((row) => {
        const [id, name, listenPort, domain, targetPort, created] = row;
        return {
          id: String(id),
          name: String(name),
          listenPort: Number(listenPort),
          domain: String(domain),
          targetPort: Number(targetPort),
          created: Number(created)
        };
      });
    });
  }

  public async saveWithConnection(conn: oracledb.Connection, proxies: Proxy[]): Promise<void> {
    if (proxies.length === 0) {
      await conn.execute(`DELETE FROM olp_proxies`);
      return;
    }

    const currentIds = proxies.map((p) => p.id);
    const placeholders = currentIds.map((_, i) => `:id${i}`).join(', ');
    const bindParams: Record<string, string | number> = {};
    currentIds.forEach((id, i) => {
      bindParams[`id${i}`] = id;
    });

    await conn.execute(
      `DELETE FROM olp_proxies WHERE proxy_id NOT IN (${placeholders})`,
      bindParams
    );

    for (const proxy of proxies) {
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
          id: proxy.id,
          name: proxy.name,
          lport: proxy.listenPort,
          domain: proxy.domain,
          tport: proxy.targetPort,
          created: proxy.created
        }
      );
    }
  }

  public async save(proxies: Proxy[]): Promise<void> {
    return this.poolManager.withConnection(async (conn) => {
      await this.saveWithConnection(conn, proxies);
      await conn.commit();
    });
  }
}

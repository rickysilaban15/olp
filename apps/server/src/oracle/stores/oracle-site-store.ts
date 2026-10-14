import type oracledb from 'oracledb';
import type { Site, SiteStore, SiteType } from '../../sites.js';
import type { OraclePoolManager } from '../oracle-pool.js';

export class OracleSiteStore implements SiteStore {
  private poolManager: OraclePoolManager;

  constructor(poolManager: OraclePoolManager) {
    this.poolManager = poolManager;
  }

  public async list(): Promise<Site[]> {
    return this.poolManager.withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT site_id, name, site_type, root_path, port, created_at_epoch
         FROM olp_sites
         ORDER BY created_at_epoch ASC`
      );

      if (!result.rows || !Array.isArray(result.rows)) {
        return [];
      }

      return (result.rows as unknown[][]).map((row) => {
        const [id, name, type, rootPath, port, created] = row;
        return {
          id: String(id),
          name: String(name),
          type: String(type) as SiteType,
          path: String(rootPath),
          port: Number(port),
          created: Number(created)
        };
      });
    });
  }

  public async saveWithConnection(conn: oracledb.Connection, sites: Site[]): Promise<void> {
    // Menghapus situs yang tidak ada lagi di daftar input
    if (sites.length === 0) {
      await conn.execute(`DELETE FROM olp_sites`);
      return;
    }

    const currentIds = sites.map((s) => s.id);
    // Hapus yang tidak ada di currentIds
    const placeholders = currentIds.map((_, i) => `:id${i}`).join(', ');
    const bindParams: Record<string, string | number> = {};
    currentIds.forEach((id, i) => {
      bindParams[`id${i}`] = id;
    });

    await conn.execute(
      `DELETE FROM olp_sites WHERE site_id NOT IN (${placeholders})`,
      bindParams
    );

    // Simpan atau perbarui setiap situs
    for (const site of sites) {
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
          id: site.id,
          name: site.name,
          stype: site.type,
          rpath: site.path,
          port: site.port,
          created: site.created
        }
      );
    }
  }

  public async save(sites: Site[]): Promise<void> {
    return this.poolManager.withConnection(async (conn) => {
      await this.saveWithConnection(conn, sites);
      await conn.commit();
    });
  }
}

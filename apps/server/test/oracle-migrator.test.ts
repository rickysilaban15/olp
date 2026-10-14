import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  parseMigrationFilename,
  calculateChecksum,
  splitSqlStatements,
  loadMigrationFiles,
  runVersionedMigrations,
  MigrationError,
  type MigrationConnection,
  type MigrationFile
} from '../src/oracle/migrator.js';

describe('Oracle Versioned Migrator', () => {
  describe('parseMigrationFilename', () => {
    it('parses valid migration filenames', () => {
      const res = parseMigrationFilename('V001__init_migrations.sql');
      expect(res.version).toBe('V001');
      expect(res.versionNumber).toBe(1);
      expect(res.description).toBe('init migrations');

      const res2 = parseMigrationFilename('V042__add_new_feature_table.sql');
      expect(res2.version).toBe('V042');
      expect(res2.versionNumber).toBe(42);
      expect(res2.description).toBe('add new feature table');
    });

    it('rejects invalid migration filenames', () => {
      expect(() => parseMigrationFilename('invalid.sql')).toThrow(MigrationError);
      expect(() => parseMigrationFilename('V_init.sql')).toThrow(MigrationError);
      expect(() => parseMigrationFilename('V001-init.sql')).toThrow(MigrationError);
    });
  });

  describe('calculateChecksum & splitSqlStatements', () => {
    it('computes 64-char SHA-256 hex checksum', () => {
      const sql = 'SELECT 1 FROM dual;';
      const checksum = calculateChecksum(sql);
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(calculateChecksum(sql + '\n\n')).toBe(checksum); // trims whitespace
    });

    it('splits SQL statements properly and ignores comments', () => {
      const sql = `
        -- Header comment
        CREATE TABLE t1 (id NUMBER);
        -- In-between comment
        CREATE TABLE t2 (id NUMBER);
      `;
      const stmts = splitSqlStatements(sql);
      expect(stmts.length).toBe(2);
      expect(stmts[0]).toContain('CREATE TABLE t1');
      expect(stmts[1]).toContain('CREATE TABLE t2');
    });
  });

  describe('loadMigrationFiles', () => {
    it('loads and sorts migrations from the migrations directory', () => {
      const dir = join(__dirname, '../src/oracle/migrations');
      const loaded = loadMigrationFiles(dir);

      expect(loaded.length).toBeGreaterThanOrEqual(2);
      expect(loaded[0]!.version).toBe('V001');
      expect(loaded[1]!.version).toBe('V002');
      expect(loaded[0]!.versionNumber).toBe(1);
      expect(loaded[1]!.versionNumber).toBe(2);
      expect(loaded[0]!.checksum).toBeDefined();
    });
  });

  describe('runVersionedMigrations execution flow', () => {
    it('applies migrations in strict sequence on a clean database', async () => {
      const executedQueries: string[] = [];
      const tablesInDb = new Set<string>();
      const appliedRows: unknown[][] = [];

      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string, binds?: Record<string, unknown>) => {
          executedQueries.push(sql);

          // Mock checkTableExists
          if (sql.includes('FROM user_tables')) {
            const tbl = binds?.['tbl'] as string;
            const exists = tablesInDb.has(tbl.toUpperCase());
            return { rows: exists ? [[tbl]] : [] };
          }

          // Mock table creation
          if (sql.includes('CREATE TABLE olp_migration_lock')) {
            tablesInDb.add('OLP_MIGRATION_LOCK');
            return { rowsAffected: 1 };
          }
          if (sql.includes('CREATE TABLE olp_schema_migrations')) {
            tablesInDb.add('OLP_SCHEMA_MIGRATIONS');
            return { rowsAffected: 1 };
          }
          if (sql.includes('CREATE TABLE olp_sanity_probe')) {
            tablesInDb.add('OLP_SANITY_PROBE');
            return { rowsAffected: 1 };
          }

          // Mock getAppliedMigrations
          if (sql.includes('FROM olp_schema_migrations ORDER BY version')) {
            return { rows: appliedRows };
          }

          // Mock recording migration status
          if (sql.includes('MERGE INTO olp_schema_migrations')) {
            return { rowsAffected: 1 };
          }
          if (sql.includes('SET status = \'SUCCESS\'')) {
            appliedRows.push([binds?.['ver'], 'desc', 'mock-checksum', 'SUCCESS', new Date().toISOString(), 10, 'migrator', null]);
            return { rowsAffected: 1 };
          }

          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const testMigrations: MigrationFile[] = [
        {
          version: 'V001',
          versionNumber: 1,
          description: 'init',
          filename: 'V001__init.sql',
          sql: 'SELECT 1 FROM dual;',
          checksum: 'checksum-1'
        },
        {
          version: 'V002',
          versionNumber: 2,
          description: 'sanity probe',
          filename: 'V002__sanity.sql',
          sql: 'CREATE TABLE olp_sanity_probe (id VARCHAR2(32));',
          checksum: 'checksum-2'
        }
      ];

      const res = await runVersionedMigrations(mockConn, testMigrations, 'test_operator');
      expect(res.appliedCount).toBe(2);
      expect(res.skippedCount).toBe(0);
      expect(res.appliedVersions).toEqual(['V001', 'V002']);
      expect(mockConn.commit).toHaveBeenCalled();
    });

    it('skips already applied migrations with matching checksums', async () => {
      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FROM user_tables')) {
            return { rows: [['OLP_MIGRATION_LOCK'], ['OLP_SCHEMA_MIGRATIONS']] };
          }
          if (sql.includes('FROM olp_schema_migrations ORDER BY version')) {
            return {
              rows: [
                ['V001', 'init', 'exact-checksum-1', 'SUCCESS', '2026-10-14T10:00:00Z', 12, 'operator', null]
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const testMigrations: MigrationFile[] = [
        {
          version: 'V001',
          versionNumber: 1,
          description: 'init',
          filename: 'V001__init.sql',
          sql: 'SELECT 1 FROM dual;',
          checksum: 'exact-checksum-1'
        }
      ];

      const res = await runVersionedMigrations(mockConn, testMigrations);
      expect(res.appliedCount).toBe(0);
      expect(res.skippedCount).toBe(1);
      expect(res.appliedVersions).toEqual([]);
    });

    it('throws MigrationError when a previously applied migration checksum is altered', async () => {
      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FROM user_tables')) {
            return { rows: [['OLP_MIGRATION_LOCK'], ['OLP_SCHEMA_MIGRATIONS']] };
          }
          if (sql.includes('FROM olp_schema_migrations ORDER BY version')) {
            return {
              rows: [
                ['V001', 'init', 'original-checksum', 'SUCCESS', '2026-10-14T10:00:00Z', 12, 'operator', null]
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const alteredMigration: MigrationFile = {
        version: 'V001',
        versionNumber: 1,
        description: 'init',
        filename: 'V001__init.sql',
        sql: 'ALTERED SQL STATEMENT;',
        checksum: 'tampered-checksum'
      };

      await expect(runVersionedMigrations(mockConn, [alteredMigration])).rejects.toThrow(
        /Migration checksum mismatch for V001/
      );
    });

    it('detects partial objects when recovering from an interrupted/crashed migration', async () => {
      const mockConn: MigrationConnection = {
        execute: vi.fn().mockImplementation(async (sql: string, binds?: Record<string, unknown>) => {
          if (sql.includes('FROM user_tables')) {
            const tbl = binds?.['tbl'] as string;
            if (tbl && tbl.toUpperCase() === 'OLP_PARTIAL_TABLE') {
              return { rows: [['OLP_PARTIAL_TABLE']] };
            }
            return { rows: [['OLP_MIGRATION_LOCK'], ['OLP_SCHEMA_MIGRATIONS']] };
          }
          if (sql.includes('FROM olp_schema_migrations ORDER BY version')) {
            return {
              rows: [
                ['V003', 'crashed migration', 'checksum-3', 'FAILED', '2026-10-14T10:00:00Z', 5, 'operator', 'ORA-00001']
              ]
            };
          }
          return { rowsAffected: 1 };
        }),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined)
      };

      const crashedMigration: MigrationFile = {
        version: 'V003',
        versionNumber: 3,
        description: 'crashed migration',
        filename: 'V003__crashed.sql',
        sql: 'CREATE TABLE olp_partial_table (id NUMBER);',
        checksum: 'checksum-3',
        expectedTables: ['OLP_PARTIAL_TABLE']
      };

      await expect(runVersionedMigrations(mockConn, [crashedMigration])).rejects.toThrow(
        /Partial database objects detected: \[OLP_PARTIAL_TABLE\]/
      );
    });
  });
});

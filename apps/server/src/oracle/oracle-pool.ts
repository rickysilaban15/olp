import oracledb from 'oracledb';

export interface OracleConfig {
  host: string;
  port: number;
  serviceName: string;
  user: string;
  password?: string;
  poolMin: number;
  poolMax: number;
  poolIncrement: number;
  poolTimeout: number; // detik
  connectTimeout: number; // milidetik
  maxRetries: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
}

export type PoolStatus = 'uninitialized' | 'initializing' | 'healthy' | 'degraded' | 'closed';

export class OraclePoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OraclePoolError';
  }
}

/**
 * Membaca dan memvalidasi konfigurasi Oracle dari environment.
 * Mengikuti prinsip least-privilege (menolak/memperingatkan jika memakai akun SYS/SYSTEM).
 */
export function resolveOracleConfig(env: NodeJS.ProcessEnv = process.env): OracleConfig {
  const host = env['OLP_ORACLE_HOST'] ?? env['ORACLE_HOST'] ?? '127.0.0.1';
  const port = Number.parseInt(env['OLP_ORACLE_PORT'] ?? env['ORACLE_PORT'] ?? '1521', 10);
  const serviceName = env['OLP_ORACLE_SERVICE_NAME'] ?? env['ORACLE_SERVICE_NAME'] ?? 'FREEPDB1';
  const user = env['OLP_ORACLE_USER'] ?? env['ORACLE_USER'] ?? 'olp_app';
  const password = env['OLP_ORACLE_PASSWORD'] ?? env['ORACLE_PASSWORD'] ?? '';

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new OraclePoolError(`Invalid ORACLE_PORT: ${env['OLP_ORACLE_PORT'] ?? env['ORACLE_PORT']}`);
  }

  // Prinsip Least Privilege: Larang keras menjalankan OLP dengan SYS atau SYSTEM
  const normalizedUser = user.trim().toUpperCase();
  if (normalizedUser === 'SYS' || normalizedUser === 'SYSTEM') {
    throw new OraclePoolError(
      `Running OLP as administrative user '${user}' is strictly forbidden by security policy. Use an application user (e.g. 'olp_app').`
    );
  }

  const poolMin = Math.max(1, Number.parseInt(env['OLP_ORACLE_POOL_MIN'] ?? env['ORACLE_POOL_MIN'] ?? '2', 10) || 2);
  const poolMax = Math.max(poolMin, Number.parseInt(env['OLP_ORACLE_POOL_MAX'] ?? env['ORACLE_POOL_MAX'] ?? '10', 10) || 10);
  const poolIncrement = Number.parseInt(env['OLP_ORACLE_POOL_INCREMENT'] ?? env['ORACLE_POOL_INCREMENT'] ?? '1', 10) || 1;
  const poolTimeout = Number.parseInt(env['OLP_ORACLE_POOL_TIMEOUT'] ?? env['ORACLE_POOL_TIMEOUT'] ?? '60', 10) || 60;
  const connectTimeout = Number.parseInt(env['OLP_ORACLE_CONNECT_TIMEOUT'] ?? env['ORACLE_CONNECT_TIMEOUT'] ?? '10000', 10) || 10000;
  const rawMaxRetries = env['OLP_ORACLE_MAX_RETRIES'] ?? env['ORACLE_MAX_RETRIES'];
  const maxRetries = rawMaxRetries !== undefined ? Number.parseInt(rawMaxRetries, 10) : 5;

  return {
    host,
    port,
    serviceName,
    user,
    password,
    poolMin,
    poolMax,
    poolIncrement,
    poolTimeout,
    connectTimeout,
    maxRetries: Number.isNaN(maxRetries) ? 5 : maxRetries,
    retryInitialDelayMs: 200,
    retryMaxDelayMs: 3000
  };
}

/**
 * Driver interface minimal untuk memudahkan mocking dan pengujian terisolasi.
 */
export interface OracleDriverInterface {
  createPool(options: oracledb.PoolAttributes): Promise<oracledb.Pool>;
}

/**
 * Manajer siklus hidup Connection Pool Oracle.
 * Menangani inisialisasi dengan retry terbatas (finite backoff), health check,
 * eksekusi query yang aman, dan shutdown yang bersih.
 */
export class OraclePoolManager {
  private config: OracleConfig;
  private driver: OracleDriverInterface;
  private pool: oracledb.Pool | null = null;
  private status: PoolStatus = 'uninitialized';
  private sleepFn: (ms: number) => Promise<void>;

  constructor(
    config?: Partial<OracleConfig>,
    driver: OracleDriverInterface = oracledb as unknown as OracleDriverInterface,
    sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: NodeJS.ProcessEnv = process.env
  ) {
    this.config = { ...resolveOracleConfig(env), ...config };
    this.driver = driver;
    this.sleepFn = sleepFn;
  }

  public getStatus(): PoolStatus {
    return this.status;
  }

  public getConnectString(): string {
    return `${this.config.host}:${this.config.port}/${this.config.serviceName}`;
  }

  /**
   * Menginisialisasi pool dengan retry terbatas dan backoff eksponensial.
   * DILARANG melakukan retry tanpa batas (infinite loop).
   */
  public async initialize(): Promise<void> {
    if (this.pool && this.status === 'healthy') {
      return;
    }

    this.status = 'initializing';
    const connectString = this.getConnectString();
    let attempt = 0;
    let delay = this.config.retryInitialDelayMs;
    let lastError: unknown = null;

    while (attempt < this.config.maxRetries) {
      attempt++;
      try {
        this.pool = await this.driver.createPool({
          user: this.config.user,
          password: this.config.password,
          connectString,
          poolMin: this.config.poolMin,
          poolMax: this.config.poolMax,
          poolIncrement: this.config.poolIncrement,
          poolTimeout: this.config.poolTimeout
        });

        this.status = 'healthy';
        return;
      } catch (err: unknown) {
        lastError = err;
        if (attempt >= this.config.maxRetries) {
          break;
        }
        await this.sleepFn(delay);
        delay = Math.min(delay * 2, this.config.retryMaxDelayMs);
      }
    }

    this.status = 'degraded';
    const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new OraclePoolError(
      `Failed to initialize Oracle connection pool after ${this.config.maxRetries} attempts: ${errMsg}`
    );
  }

  /**
   * Melakukan health check koneksi dengan query 'SELECT 1 FROM DUAL'.
   */
  public async healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    if (!this.pool || this.status !== 'healthy') {
      return { ok: false, error: `Pool is not healthy (current status: ${this.status})` };
    }

    const start = Date.now();
    let conn: oracledb.Connection | null = null;
    try {
      conn = await this.pool.getConnection();
      await conn.execute('SELECT 1 FROM DUAL');
      const latencyMs = Date.now() - start;
      return { ok: true, latencyMs };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: errMsg };
    } finally {
      if (conn) {
        try {
          await conn.close();
        } catch {
          // Abaikan error saat melepas koneksi rusak
        }
      }
    }
  }

  public async ping(): Promise<boolean> {
    const res = await this.healthCheck();
    return res.ok;
  }

  public async getConnection(): Promise<oracledb.Connection> {
    if (!this.pool || this.status !== 'healthy') {
      throw new OraclePoolError(`Cannot acquire connection: pool status is '${this.status}'`);
    }
    return this.pool.getConnection();
  }

  /**
   * Menjalankan operasi dengan koneksi yang diperoleh dari pool,
   * dan memastikan koneksi selalu dilepas kembali ke pool.
   */
  public async withConnection<T>(fn: (conn: oracledb.Connection) => Promise<T>): Promise<T> {
    if (!this.pool || this.status !== 'healthy') {
      throw new OraclePoolError(`Cannot acquire connection: pool status is '${this.status}'`);
    }

    const conn = await this.pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      try {
        await conn.close();
      } catch {
        // Abaikan error saat melepaskan koneksi
      }
    }
  }

  /**
   * Menutup seluruh koneksi pool secara tertib (graceful shutdown).
   */
  public async close(drainTimeSec: number = 2): Promise<void> {
    if (!this.pool) {
      this.status = 'closed';
      return;
    }

    try {
      await this.pool.close(drainTimeSec);
    } catch {
      // Abaikan error saat menutup pool
    } finally {
      this.pool = null;
      this.status = 'closed';
    }
  }

  /**
   * Memasang hook penutupan aman pada sinyal sistem (SIGTERM, SIGINT).
   */
  public registerShutdownHooks(processObj: NodeJS.Process = process): () => void {
    const handler = async (signal: string) => {
      try {
        await this.close();
      } catch {
        // Selesaikan shutdown
      }
    };

    const sigtermListener = () => { void handler('SIGTERM'); };
    const sigintListener = () => { void handler('SIGINT'); };

    processObj.on('SIGTERM', sigtermListener);
    processObj.on('SIGINT', sigintListener);

    return () => {
      processObj.off('SIGTERM', sigtermListener);
      processObj.off('SIGINT', sigintListener);
    };
  }
}

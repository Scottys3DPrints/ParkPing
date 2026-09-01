import type { Config } from '../config.js';

/**
 * Minimal database surface shared by the two drivers.
 *
 * Production runs against a real PostgreSQL server. Development and tests run
 * against PGlite — the same Postgres engine compiled to WebAssembly — so there
 * is no separate SQL dialect to keep in sync and no service to install before
 * `npm run dev` works.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /**
   * Runs one or more statements with no parameters.
   *
   * Separate from `query` because the extended (parameterized) protocol accepts
   * exactly one statement per round trip, so a multi-statement migration sent
   * through `query` fails to parse. This path uses the simple protocol.
   */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgliteDb implements Db {
  #inTransaction: boolean;

  constructor(
    private readonly client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
      exec: (sql: string) => Promise<unknown>;
      close?: () => Promise<void>;
    },
    inTransaction = false,
  ) {
    this.#inTransaction = inTransaction;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, [...params]);
    const rows = (result.rows ?? []) as T[];
    // PGlite reports `affectedRows` for writes and leaves it at 0 for reads.
    return { rows, rowCount: rows.length > 0 ? rows.length : result.affectedRows ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // PGlite is single-connection; nested BEGIN would fail. Reuse the outer one.
    if (this.#inTransaction) return fn(this);
    await this.client.query('BEGIN');
    try {
      const result = await fn(new PgliteDb(this.client, true));
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}

class PostgresDb implements Db {
  constructor(
    private readonly pool: import('pg').Pool,
    private readonly client?: import('pg').PoolClient,
  ) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const executor = this.client ?? this.pool;
    const result = await executor.query(sql, [...params]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    const executor = this.client ?? this.pool;
    await executor.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresDb(this.pool, client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.client) return;
    await this.pool.end();
  }
}

export async function createDb(config: Config): Promise<Db> {
  if (config.database.url) {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: config.database.url,
      max: 10,
      // Managed Postgres providers generally terminate plaintext connections.
      ssl: config.database.url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    });
    // Fail fast on a bad connection string rather than on the first request.
    const probe = await pool.connect();
    probe.release();
    return new PostgresDb(pool);
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const dataDir = config.database.embeddedPath === 'memory://' ? undefined : config.database.embeddedPath;
  if (dataDir) {
    // PGlite creates only the leaf directory, so a nested path like
    // %LOCALAPPDATA%/ParkPing/pgdata fails with ENOENT unless the parents
    // already exist. Cheap to guarantee here.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
  }
  const client = await PGlite.create(dataDir);
  return new PgliteDb(client as unknown as ConstructorParameters<typeof PgliteDb>[0]);
}

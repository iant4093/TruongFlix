// Loaded at run time so Vite doesn't try to bundle the built-in for the jsdom environment.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** A real in-memory SQLite database behind the `@tauri-apps/plugin-sql` interface (`$1` params). */
export function memoryDb() {
  const db = new DatabaseSync(':memory:');
  const sql = (q: string) => q.replace(/\$(\d+)/g, '?$1');
  const values = (params: unknown[]) => params.map((v) => (typeof v === 'boolean' ? Number(v) : v ?? null)) as never[];
  return {
    raw: db,
    execute: async (q: string, params: unknown[] = []) => {
      const r = db.prepare(sql(q)).run(...values(params));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
    select: async <T>(q: string, params: unknown[] = []) => db.prepare(sql(q)).all(...values(params)) as T,
  };
}

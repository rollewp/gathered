import 'server-only'
import { Pool, type PoolClient } from 'pg'
import { findPersona } from '@/lib/personas'

// The ONLY database access point in the app (ground rule). Runtime uses DATABASE_URL (gathered_app).
// DATABASE_OWNER_URL is for migrations/seeds and must never be referenced here.
const g = globalThis as unknown as { __gatheredPool?: Pool }

function pool(): Pool {
  if (!g.__gatheredPool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    g.__gatheredPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }, // same as the validated spike/scripts
      max: 3, // small: serverless instances each hold their own pool
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000, // allows for Lakebase cold start
    })
  }
  return g.__gatheredPool
}

export async function withPersona<T>(personaKey: string | undefined, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const persona = findPersona(personaKey)
  if (!persona) throw new Error('Unknown persona')
  const client = await pool().connect()
  try {
    await client.query('begin')
    // set_config(..., true) is transaction-local, so everything below shares this transaction.
    await client.query("select set_config('app.role', $1, true), set_config('app.person_id', $2, true)", [persona.role, persona.person_id])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    try { await client.query('rollback') } catch { /* connection may be gone */ }
    throw err
  } finally {
    client.release()
  }
}

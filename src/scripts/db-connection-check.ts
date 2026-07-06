import { PrismaClient } from '@prisma/client'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type MigrationRow = {
  migration_name: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

const PLACEHOLDER_VALUES = new Set([
  'DB_HOST',
  'PASSWORD',
  'USER',
  'USERNAME',
  'HOST',
  'DATABASE',
])

function safeDatasourceSummary(rawUrl: string) {
  const parsed = new URL(rawUrl)
  return {
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname,
    port: parsed.port || null,
    database: parsed.pathname.replace(/^\//, '') || null,
    usernameSet: Boolean(parsed.username),
    passwordSet: Boolean(parsed.password),
    sslMode: parsed.searchParams.get('sslmode') || null,
  }
}

function validateDatabaseUrl(rawUrl: string) {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return {
      ok: false as const,
      reason: 'invalid_database_url',
      message: 'DATABASE_URL must be a valid PostgreSQL connection string.',
    }
  }

  const protocol = parsed.protocol.replace(':', '')
  if (!['postgresql', 'postgres'].includes(protocol)) {
    return {
      ok: false as const,
      reason: 'invalid_database_protocol',
      message: 'DATABASE_URL must start with postgresql:// or postgres://.',
    }
  }

  const decodedUsername = decodeURIComponent(parsed.username || '')
  const decodedPassword = decodeURIComponent(parsed.password || '')
  const host = parsed.hostname

  if (!host || PLACEHOLDER_VALUES.has(host) || host.includes('_HOST')) {
    return {
      ok: false as const,
      reason: 'placeholder_database_host',
      message: 'DATABASE_URL still contains the placeholder host. Replace DB_HOST with the real database hostname.',
    }
  }

  if (!decodedPassword || PLACEHOLDER_VALUES.has(decodedPassword)) {
    return {
      ok: false as const,
      reason: 'placeholder_database_password',
      message: 'DATABASE_URL still contains the placeholder password. Replace PASSWORD with the real database password.',
    }
  }

  if (!decodedUsername || PLACEHOLDER_VALUES.has(decodedUsername)) {
    return {
      ok: false as const,
      reason: 'placeholder_database_username',
      message: 'DATABASE_URL needs the real database username.',
    }
  }

  return { ok: true as const }
}

function loadLocalEnvIfPresent() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return false

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()
    if (!key || process.env[key] !== undefined) continue

    process.env[key] = rawValue.replace(/^["']|["']$/g, '')
  }

  return true
}

async function main() {
  const loadedLocalEnv = loadLocalEnvIfPresent()
  const databaseUrl = process.env.DATABASE_URL
  const connectOnly = process.argv.includes('--connect-only')

  if (!databaseUrl) {
    console.error(JSON.stringify({
      ok: false,
      reason: 'missing_database_url',
      message: 'DATABASE_URL is required. Create a local .env or export DATABASE_URL before running db:check.',
      loadedLocalEnv,
    }, null, 2))
    process.exit(1)
  }

  const validation = validateDatabaseUrl(databaseUrl)
  if (!validation.ok) {
    console.error(JSON.stringify({
      ok: false,
      reason: validation.reason,
      message: validation.message,
      loadedLocalEnv,
      datasource: safeDatasourceSummary(databaseUrl),
    }, null, 2))
    process.exit(1)
  }

  const startedAt = new Date()
  const prisma = new PrismaClient({
    log: ['error'],
  })

  try {
    await prisma.$queryRaw`SELECT 1`

    let migrations: MigrationRow[] = []
    let migrationsTableReachable = false

    if (!connectOnly) {
      try {
        migrations = await prisma.$queryRaw<MigrationRow[]>`
          SELECT migration_name, finished_at, rolled_back_at
          FROM _prisma_migrations
          ORDER BY finished_at DESC NULLS LAST, migration_name DESC
          LIMIT 5
        `
        migrationsTableReachable = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('_prisma_migrations')) throw error
      }
    }

    const failedMigrations = migrations.filter((migration) => migration.rolled_back_at)

    console.log(JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt.getTime(),
      loadedLocalEnv,
      datasource: safeDatasourceSummary(databaseUrl),
      prismaMigrations: {
        reachable: migrationsTableReachable,
        latest: migrations[0]?.migration_name || null,
        recent: migrations.map((migration) => ({
          name: migration.migration_name,
          finishedAt: migration.finished_at?.toISOString?.() || migration.finished_at,
          rolledBack: Boolean(migration.rolled_back_at),
        })),
        rolledBackCountInRecentSample: failedMigrations.length,
      },
      mode: connectOnly ? 'connect_only' : 'full',
    }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt.getTime(),
      loadedLocalEnv,
      datasource: safeDatasourceSummary(databaseUrl),
      reason: 'database_check_failed',
      message: error instanceof Error ? error.message : String(error),
    }, null, 2))
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main()

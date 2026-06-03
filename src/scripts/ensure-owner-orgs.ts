import { PrismaClient } from '@prisma/client'
import {
  bootstrapOwnerOrganizations,
  summarizeOwnerOrgPlan,
  validateOwnerOrgPlan,
} from '../lib/owner-org-bootstrap.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const resetSamples = args.includes('--reset-samples')
const ownerEmailArg = args.find((arg) => arg.startsWith('--email='))?.split('=')[1]
const ownerEmail = ownerEmailArg || 'tareq@fc.sa'

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    ownerEmail,
    accountValidation: validateOwnerOrgPlan(),
    orgs: summarizeOwnerOrgPlan(),
  }, null, 2))
  process.exit(0)
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Refusing to bootstrap owner organizations without an explicit database connection.')
  process.exit(1)
}

const prisma = new PrismaClient()

bootstrapOwnerOrganizations(prisma, { ownerEmail, resetSamples })
  .then((result) => {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

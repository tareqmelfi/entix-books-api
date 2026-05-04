import { Hono } from 'hono'
import { requireAuth } from '../auth.js'
import { prisma } from '../db.js'

export const meRoutes = new Hono()

meRoutes.use('*', requireAuth)

// GET /me — current user + memberships
meRoutes.get('/', async (c) => {
  const auth = c.get('auth')
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    include: {
      memberships: {
        include: {
          org: { select: { id: true, slug: true, name: true, baseCurrency: true, country: true } },
        },
      },
    },
  })
  return c.json(user)
})

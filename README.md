# entix-books-api

Backend API for [entix.io](https://entix.io) · Hono + Prisma + PostgreSQL · TypeScript.

## Stack

- **Runtime:** Node 22 · Hono 4
- **DB:** PostgreSQL 16 · Prisma 5
- **Auth:** Logto JWT verification (jose) · DEMO mode when LOGTO_ENDPOINT is unset
- **Validation:** Zod via @hono/zod-validator
- **Deploy:** Docker → Coolify on `api.entix.io`

## Endpoints

| Method | Path | Auth | Notes |
|:---|:---|:---:|:---|
| GET | `/` | - | service info |
| GET | `/health` | - | DB ping |
| GET | `/me` | ✅ | current user + memberships |
| GET | `/orgs` | ✅ | list user's orgs |
| POST | `/orgs` | ✅ | create org · seeds CoA + tax rates |
| GET | `/orgs/:id` | ✅ | org by id |
| GET | `/api/contacts` | ✅✅ | list contacts (auth + org) · `?type=CUSTOMER&q=foo&page=1` |
| POST | `/api/contacts` | ✅✅ | create contact |
| GET | `/api/contacts/:id` | ✅✅ | one contact |
| PATCH | `/api/contacts/:id` | ✅✅ | update |
| DELETE | `/api/contacts/:id` | ✅✅ | soft delete |
| GET/POST/PATCH/DEL | `/api/accounts` | ✅✅ | chart of accounts CRUD |
| GET/POST/PATCH/DEL | `/api/invoices` | ✅✅ | sales invoices · auto-numbers · auto-totals |

✅ = requires Bearer JWT
✅✅ = requires Bearer JWT + `X-Org-Id` header

## Local dev

```bash
cp .env.example .env
# fill DATABASE_URL · leave LOGTO_* empty for demo mode
npm install
npx prisma migrate dev
npm run dev
```

## Production deploy

Coolify builds from `Dockerfile` · runs `prisma migrate deploy` on container start · serves on port 3000.

## DEMO mode

If `LOGTO_ENDPOINT` is empty:
- All requests bypass JWT verification
- A `demo@entix.io` user is auto-created on first request
- This is for V0.1 only · production WILL require Logto

When you set `LOGTO_ENDPOINT`, demo mode is automatically off.

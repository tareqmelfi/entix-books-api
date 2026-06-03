import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const orgSlug =
  args.find((arg) => arg.startsWith('--org='))?.split('=')[1] ||
  process.env.ENTIX_ORG_SLUG ||
  'ensidex'
const paymentLinkUrl =
  args.find((arg) => arg.startsWith('--payment-link-url='))?.split('=').slice(1).join('=') ||
  process.env.SNBL_STRIPE_PAYMENT_LINK_URL ||
  null

const invoiceNumber = 'EN-SNBL-ENG01-20260603'
const clientCode = 'EN-CLI-SNBL'
const shortCode = 'SNBL'

const lines = [
  {
    description:
      'Go-Live Strategy & Campaign Architecture - Campaign structure, objective mapping, audience segmentation, launch checklist, and initial messaging angles for the Marketing Go-Live scope.',
    quantity: '1',
    unitPrice: '489.00',
  },
  {
    description:
      'Launch Assets & Tracking Readiness - Ad copy direction, creative package coordination, landing/readiness review, and conversion-tracking map for campaign activation.',
    quantity: '1',
    unitPrice: '425.00',
  },
  {
    description:
      'Initial Optimization & Reporting Setup - First optimization-cycle framework, KPI sheet, weekly reporting format, and handover notes for the engagement file.',
    quantity: '1',
    unitPrice: '325.00',
  },
]

function dec(value: string | number) {
  return new Prisma.Decimal(value)
}

function totalLines() {
  return lines.reduce((sum, line) => sum.plus(dec(line.quantity).mul(dec(line.unitPrice))), new Prisma.Decimal(0))
}

async function main() {
  const contactData = {
    customCode: clientCode,
    shortCode,
    type: 'CUSTOMER' as const,
    isCustomer: true,
    isSupplier: false,
    entityKind: 'COMPANY' as const,
    displayName: 'Al Sunbulah Al Jadidah',
    legalName: 'Al Sunbulah Al Jadidah',
    email: 'sds_2222@hotmail.com',
    phone: '+966553132222',
    crNumber: '7051245541',
    country: 'SA',
    city: 'Riyadh',
    addressLine1: 'Riyadh, Saudi Arabia',
    defaultCurrency: 'USD',
    isForeign: true,
    notes: [
      'Client Code: EN-CLI-SNBL',
      'Commercial Registration: 7051245541',
      'Project: ENG-01-Marketing-Go-Live',
      'Engagement: ENG-Engagement',
      'Accounting status: register_after_payment',
    ].join('\n'),
  }

  const subtotal = totalLines()
  const invoiceData = {
    invoiceNumber,
    status: 'SENT' as const,
    issueDate: new Date('2026-06-03T00:00:00.000Z'),
    dueDate: new Date('2026-06-10T00:00:00.000Z'),
    currency: 'USD',
    exchangeRate: dec(1),
    subtotal,
    taxTotal: dec(0),
    discountTotal: dec(0),
    total: subtotal,
    amountPaid: dec(0),
    notes: [
      'This invoice covers a partial Marketing Go-Live engagement scope under ENG-01-Marketing-Go-Live.',
      'Media spend, platform ad budget, and third-party costs are not included unless approved separately.',
      'Reference Equivalent: approximately SAR 4,646.25.',
      'Stripe metadata: client_code=EN-CLI-SNBL; commercial_registration=7051245541; accounting_status=register_after_payment.',
    ].join('\n'),
    termsConditions: 'Payment Terms: Net 7. Due Date: June 10, 2026.',
    paymentLinkUrl,
    paymentLinkProvider: paymentLinkUrl ? 'stripe' : null,
  }

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      orgSelector: { slug: orgSlug, legalName: 'ENSIDEX LLC' },
      contact: contactData,
      invoice: { ...invoiceData, subtotal: String(subtotal), total: String(subtotal) },
      lines,
    }, null, 2))
    return
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Refusing to write without an explicit database connection.')
  }

  const org = await prisma.organization.findFirst({
    where: {
      OR: [
        { slug: orgSlug },
        { legalName: 'ENSIDEX LLC' },
        { name: 'ENSIDEX LLC' },
        { name: 'ENSIDEX' },
      ],
    },
    select: { id: true, slug: true, name: true, legalName: true },
  })
  if (!org) throw new Error(`Organization not found for slug/legal name: ${orgSlug}`)

  const existingContact = await prisma.contact.findFirst({
    where: {
      orgId: org.id,
      OR: [
        { customCode: clientCode },
        { shortCode },
        { email: 'sds_2222@hotmail.com' },
        { displayName: 'Al Sunbulah Al Jadidah' },
      ],
    },
    select: { id: true },
  })

  const duplicateShortCode = await prisma.contact.findFirst({
    where: {
      orgId: org.id,
      shortCode,
      ...(existingContact ? { id: { not: existingContact.id } } : {}),
    },
    select: { id: true, displayName: true, customCode: true },
  })
  if (duplicateShortCode) {
    throw new Error(`SNBL shortCode is already used by ${duplicateShortCode.displayName} (${duplicateShortCode.id}).`)
  }

  const result = await prisma.$transaction(async (tx) => {
    const contact = existingContact
      ? await tx.contact.update({ where: { id: existingContact.id }, data: contactData })
      : await tx.contact.create({ data: { orgId: org.id, ...contactData } })

    const existingInvoice = await tx.invoice.findFirst({
      where: { orgId: org.id, invoiceNumber },
      select: { id: true },
    })

    if (existingInvoice) {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: existingInvoice.id } })
      const invoice = await tx.invoice.update({
        where: { id: existingInvoice.id },
        data: {
          ...invoiceData,
          contactId: contact.id,
          lines: {
            create: lines.map((line) => ({
              description: line.description,
              quantity: dec(line.quantity),
              unitPrice: dec(line.unitPrice),
              discount: dec(0),
              subtotal: dec(line.quantity).mul(dec(line.unitPrice)),
            })),
          },
        },
        include: { contact: true, lines: true },
      })
      return { action: 'updated', contact, invoice }
    }

    const invoice = await tx.invoice.create({
      data: {
        orgId: org.id,
        contactId: contact.id,
        ...invoiceData,
        lines: {
          create: lines.map((line) => ({
            description: line.description,
            quantity: dec(line.quantity),
            unitPrice: dec(line.unitPrice),
            discount: dec(0),
            subtotal: dec(line.quantity).mul(dec(line.unitPrice)),
          })),
        },
      },
      include: { contact: true, lines: true },
    })
    return { action: 'created', contact, invoice }
  })

  console.log(JSON.stringify({
    ok: true,
    action: result.action,
    org,
    contactId: result.contact.id,
    invoiceId: result.invoice.id,
    invoiceNumber: result.invoice.invoiceNumber,
    status: result.invoice.status,
    total: String(result.invoice.total),
    paymentLinkRegistered: Boolean(result.invoice.paymentLinkUrl),
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

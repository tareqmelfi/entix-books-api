/**
 * Email · Resend wrapper + branded HTML templates
 *
 * env vars:
 *   RESEND_API_KEY    required for production · falls back to dry-run if missing
 *   EMAIL_FROM        default: "Entix Books <noreply@entix.io>"
 *   APP_URL           default: "https://entix.io"
 *
 * Public API:
 *   sendInvoiceEmail({ to, invoice, customer, payLink? })
 *   sendQuoteEmail({ to, quote, customer, acceptLink? })
 *   sendCreditNoteEmail({ to, note, customer })
 *   sendPasswordResetEmail({ to, name, link })
 *   sendGenericEmail({ to, subject, html })
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const EMAIL_FROM = process.env.EMAIL_FROM || 'Entix Books <noreply@entix.io>'
const APP_URL = process.env.APP_URL || 'https://entix.io'

interface SendArgs {
  to: string | string[]
  subject: string
  html: string
  replyTo?: string
  cc?: string[]
  bcc?: string[]
  attachments?: Array<{ filename: string; content: string }> // base64
}

export async function sendEmail(args: SendArgs): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set · dry-run mode')
    console.log('[email] Would send to:', args.to, 'subject:', args.subject)
    return { ok: true, id: 'dry-run' }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: Array.isArray(args.to) ? args.to : [args.to],
        subject: args.subject,
        html: args.html,
        reply_to: args.replyTo,
        cc: args.cc,
        bcc: args.bcc,
        attachments: args.attachments,
      }),
    })
    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}))
      return { ok: false, error: data?.message || `HTTP ${res.status}` }
    }
    const data: any = await res.json()
    return { ok: true, id: data?.id }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'send failed' }
  }
}

// ─── HTML template builders ───────────────────────────────────────────────────

interface DocLine {
  description: string
  quantity: number | string
  unitPrice: number | string
  total?: number | string
}

interface DocPayload {
  number: string
  issueDate?: string
  dueDate?: string
  validUntil?: string
  total: number | string
  amountPaid?: number | string
  currency?: string
  notes?: string | null
  lines?: DocLine[]
}

interface CustomerPayload {
  displayName: string
  email?: string | null
  taxId?: string | null
}

interface OrgPayload {
  name?: string
  taxId?: string | null
  logoUrl?: string | null
}

function escapeHtml(s: string | undefined | null): string {
  if (!s) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function fmt(n: number | string, currency = 'SAR') {
  const v = Number(n) || 0
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

/** Shared shell · navy header · white body · soft footer · RTL Arabic body */
function htmlShell(args: {
  title: string
  preheader: string
  bodyHtml: string
  ctaUrl?: string
  ctaLabel?: string
  org?: OrgPayload
}) {
  const orgName = escapeHtml(args.org?.name || 'Entix Books')
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${escapeHtml(args.title)}</title>
</head>
<body style="margin:0; padding:0; background:#F4FCFF; font-family: 'Segoe UI', Tahoma, sans-serif; color:#0B1B49;">
  <span style="display:none; font-size:1px; color:#F4FCFF; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">
    ${escapeHtml(args.preheader)}
  </span>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4FCFF;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px; background:#FFFFFF; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(11,27,73,0.06);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0B1B49 0%,#1276E3 100%); padding:24px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td align="right">
                    <span style="color:#FFFFFF; font-size:20px; font-weight:700; letter-spacing:-0.3px;">${orgName}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 28px;">
              ${args.bodyHtml}
              ${args.ctaUrl && args.ctaLabel ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;">
                <tr>
                  <td align="center">
                    <a href="${args.ctaUrl}" style="display:inline-block; background:#1276E3; color:#FFFFFF; text-decoration:none; padding:14px 28px; border-radius:10px; font-weight:600; font-size:15px;">${escapeHtml(args.ctaLabel)}</a>
                  </td>
                </tr>
              </table>
              ` : ''}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#F9FAFB; padding:20px 28px; border-top:1px solid #E5E7EB;">
              <p style="margin:0; color:#6B7280; font-size:12px; line-height:1.6;">
                هذا البريد تم إرساله من ${orgName} عبر Entix Books. إذا وصلك بالخطأ، يمكنك تجاهله.
              </p>
              <p style="margin:8px 0 0 0; color:#9CA3AF; font-size:11px;">
                © ${new Date().getFullYear()} ENSIDEX LLC · Wyoming, United States · entix.io
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function linesTable(lines: DocLine[] | undefined, currency: string) {
  if (!lines || lines.length === 0) return ''
  const rows = lines.map((l) => {
    const total = l.total !== undefined ? Number(l.total) : Number(l.quantity) * Number(l.unitPrice)
    return `<tr>
      <td style="padding:10px 12px; border-bottom:1px solid #F3F4F6; font-size:14px; color:#374151;">${escapeHtml(l.description)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #F3F4F6; font-size:14px; color:#374151; text-align:left; direction:ltr;">${Number(l.quantity).toLocaleString()}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #F3F4F6; font-size:14px; color:#374151; text-align:left; direction:ltr;">${fmt(l.unitPrice, currency)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #F3F4F6; font-size:14px; color:#0B1B49; font-weight:600; text-align:left; direction:ltr;">${fmt(total, currency)}</td>
    </tr>`
  }).join('')
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px; border:1px solid #E5E7EB; border-radius:8px; overflow:hidden;">
    <thead>
      <tr style="background:#F9FAFB;">
        <th style="padding:10px 12px; text-align:right; font-size:12px; color:#6B7280; font-weight:600;">الوصف</th>
        <th style="padding:10px 12px; text-align:left; font-size:12px; color:#6B7280; font-weight:600;">الكمية</th>
        <th style="padding:10px 12px; text-align:left; font-size:12px; color:#6B7280; font-weight:600;">السعر</th>
        <th style="padding:10px 12px; text-align:left; font-size:12px; color:#6B7280; font-weight:600;">الإجمالي</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendInvoiceEmail(opts: {
  to: string
  invoice: DocPayload
  customer: CustomerPayload
  org?: OrgPayload
  payLink?: string
  message?: string
}) {
  const { invoice, customer, org } = opts
  const currency = invoice.currency || 'SAR'
  const customMessage = opts.message ? `<p style="margin:0 0 16px 0; color:#374151; font-size:15px; line-height:1.7;">${escapeHtml(opts.message)}</p>` : ''
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0; color:#0B1B49; font-size:24px; font-weight:700;">فاتورة جديدة من ${escapeHtml(org?.name || 'Entix Books')}</h1>
    <p style="margin:0 0 24px 0; color:#6B7280; font-size:14px;">رقم الفاتورة: <span style="font-weight:600; color:#1276E3;">${escapeHtml(invoice.number)}</span></p>
    ${customMessage}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:16px;">
      <tr>
        <td style="padding:12px 14px; background:#F4FCFF; border-radius:8px;">
          <div style="font-size:12px; color:#6B7280; margin-bottom:4px;">العميل</div>
          <div style="font-size:14px; color:#0B1B49; font-weight:600;">${escapeHtml(customer.displayName)}</div>
          ${customer.taxId ? `<div style="font-size:12px; color:#6B7280; direction:ltr;">VAT: ${escapeHtml(customer.taxId)}</div>` : ''}
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="width:50%; padding:8px 0; vertical-align:top;">
          <div style="font-size:12px; color:#6B7280;">تاريخ الإصدار</div>
          <div style="font-size:14px; color:#0B1B49; direction:ltr;">${escapeHtml(invoice.issueDate?.slice(0, 10) || '—')}</div>
        </td>
        <td style="width:50%; padding:8px 0; vertical-align:top;">
          <div style="font-size:12px; color:#6B7280;">تاريخ الاستحقاق</div>
          <div style="font-size:14px; color:#0B1B49; direction:ltr;">${escapeHtml(invoice.dueDate?.slice(0, 10) || '—')}</div>
        </td>
      </tr>
    </table>
    ${linesTable(invoice.lines, currency)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;">
      <tr>
        <td align="left" style="padding:14px; background:#0B1B49; border-radius:8px;">
          <div style="color:#94A3B8; font-size:12px; margin-bottom:4px;">الإجمالي المستحق</div>
          <div style="color:#FFFFFF; font-size:22px; font-weight:700; direction:ltr;">${fmt(invoice.total, currency)}</div>
        </td>
      </tr>
    </table>
    ${invoice.notes ? `<div style="margin-top:16px; padding:12px 14px; background:#F9FAFB; border-radius:8px; border-right:3px solid #1276E3;">
      <div style="font-size:12px; color:#6B7280; margin-bottom:4px;">ملاحظات</div>
      <div style="font-size:13px; color:#374151; white-space:pre-wrap;">${escapeHtml(invoice.notes)}</div>
    </div>` : ''}`
  return sendEmail({
    to: opts.to,
    subject: `فاتورة ${invoice.number} من ${org?.name || 'Entix Books'}`,
    html: htmlShell({
      title: `فاتورة ${invoice.number}`,
      preheader: `فاتورة بقيمة ${fmt(invoice.total, currency)} مستحقة في ${invoice.dueDate?.slice(0, 10) || ''}`,
      bodyHtml,
      ctaUrl: opts.payLink,
      ctaLabel: opts.payLink ? 'دفع الفاتورة' : undefined,
      org,
    }),
  })
}

export async function sendQuoteEmail(opts: {
  to: string
  quote: DocPayload
  customer: CustomerPayload
  org?: OrgPayload
  acceptLink?: string
  message?: string
}) {
  const { quote, customer, org } = opts
  const currency = quote.currency || 'SAR'
  const customMessage = opts.message ? `<p style="margin:0 0 16px 0; color:#374151; font-size:15px; line-height:1.7;">${escapeHtml(opts.message)}</p>` : ''
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0; color:#0B1B49; font-size:24px; font-weight:700;">عرض سعر من ${escapeHtml(org?.name || 'Entix Books')}</h1>
    <p style="margin:0 0 24px 0; color:#6B7280; font-size:14px;">رقم العرض: <span style="font-weight:600; color:#1276E3;">${escapeHtml(quote.number)}</span></p>
    ${customMessage}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:16px;">
      <tr>
        <td style="padding:12px 14px; background:#F4FCFF; border-radius:8px;">
          <div style="font-size:12px; color:#6B7280; margin-bottom:4px;">إلى</div>
          <div style="font-size:14px; color:#0B1B49; font-weight:600;">${escapeHtml(customer.displayName)}</div>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="width:50%; padding:8px 0; vertical-align:top;">
          <div style="font-size:12px; color:#6B7280;">تاريخ العرض</div>
          <div style="font-size:14px; color:#0B1B49; direction:ltr;">${escapeHtml(quote.issueDate?.slice(0, 10) || '—')}</div>
        </td>
        <td style="width:50%; padding:8px 0; vertical-align:top;">
          <div style="font-size:12px; color:#6B7280;">صالح حتى</div>
          <div style="font-size:14px; color:#0B1B49; direction:ltr;">${escapeHtml(quote.validUntil?.slice(0, 10) || '—')}</div>
        </td>
      </tr>
    </table>
    ${linesTable(quote.lines, currency)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;">
      <tr>
        <td align="left" style="padding:14px; background:#0B1B49; border-radius:8px;">
          <div style="color:#94A3B8; font-size:12px; margin-bottom:4px;">قيمة العرض</div>
          <div style="color:#FFFFFF; font-size:22px; font-weight:700; direction:ltr;">${fmt(quote.total, currency)}</div>
        </td>
      </tr>
    </table>
    ${quote.notes ? `<div style="margin-top:16px; padding:12px 14px; background:#F9FAFB; border-radius:8px; border-right:3px solid #1276E3;">
      <div style="font-size:12px; color:#6B7280; margin-bottom:4px;">شروط</div>
      <div style="font-size:13px; color:#374151; white-space:pre-wrap;">${escapeHtml(quote.notes)}</div>
    </div>` : ''}`
  return sendEmail({
    to: opts.to,
    subject: `عرض سعر ${quote.number} من ${org?.name || 'Entix Books'}`,
    html: htmlShell({
      title: `عرض سعر ${quote.number}`,
      preheader: `عرض سعر بقيمة ${fmt(quote.total, currency)} صالح حتى ${quote.validUntil?.slice(0, 10) || ''}`,
      bodyHtml,
      ctaUrl: opts.acceptLink,
      ctaLabel: opts.acceptLink ? 'مراجعة وقبول العرض' : undefined,
      org,
    }),
  })
}

export async function sendCreditNoteEmail(opts: {
  to: string
  note: DocPayload
  customer: CustomerPayload
  org?: OrgPayload
  reason?: string
}) {
  const { note, customer, org } = opts
  const currency = note.currency || 'SAR'
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0; color:#0B1B49; font-size:24px; font-weight:700;">إشعار دائن من ${escapeHtml(org?.name || 'Entix Books')}</h1>
    <p style="margin:0 0 24px 0; color:#6B7280; font-size:14px;">رقم الإشعار: <span style="font-weight:600; color:#1276E3;">${escapeHtml(note.number)}</span></p>
    ${opts.reason ? `<p style="margin:0 0 16px 0; color:#374151; font-size:14px;">السبب: ${escapeHtml(opts.reason)}</p>` : ''}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:16px;">
      <tr>
        <td style="padding:12px 14px; background:#FEF3C7; border-radius:8px;">
          <div style="font-size:12px; color:#92400E; margin-bottom:4px;">إلى</div>
          <div style="font-size:14px; color:#0B1B49; font-weight:600;">${escapeHtml(customer.displayName)}</div>
        </td>
      </tr>
    </table>
    ${linesTable(note.lines, currency)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;">
      <tr>
        <td align="left" style="padding:14px; background:#92400E; border-radius:8px;">
          <div style="color:#FCD34D; font-size:12px; margin-bottom:4px;">قيمة الإشعار الدائن</div>
          <div style="color:#FFFFFF; font-size:22px; font-weight:700; direction:ltr;">${fmt(note.total, currency)}</div>
        </td>
      </tr>
    </table>`
  return sendEmail({
    to: opts.to,
    subject: `إشعار دائن ${note.number} من ${org?.name || 'Entix Books'}`,
    html: htmlShell({
      title: `إشعار دائن ${note.number}`,
      preheader: `إشعار دائن بقيمة ${fmt(note.total, currency)}`,
      bodyHtml,
      org,
    }),
  })
}

export async function sendPasswordResetEmail(opts: { to: string; name?: string; link: string }) {
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0; color:#0B1B49; font-size:24px; font-weight:700;">إعادة تعيين كلمة المرور</h1>
    <p style="margin:0 0 16px 0; color:#374151; font-size:15px; line-height:1.7;">${opts.name ? `مرحباً ${escapeHtml(opts.name)}،` : 'مرحباً،'}</p>
    <p style="margin:0 0 16px 0; color:#374151; font-size:15px; line-height:1.7;">
      تلقّينا طلباً لإعادة تعيين كلمة المرور لحسابك في Entix Books. اضغط الزر أدناه لتعيين كلمة مرور جديدة. الرابط صالح لمدة ساعة واحدة.
    </p>
    <p style="margin:0 0 16px 0; color:#6B7280; font-size:13px; line-height:1.7;">
      إذا لم تطلب هذا، يمكنك تجاهل هذا البريد. لن يتم تغيير كلمة المرور.
    </p>`
  return sendEmail({
    to: opts.to,
    subject: 'إعادة تعيين كلمة المرور · Entix Books',
    html: htmlShell({
      title: 'إعادة تعيين كلمة المرور',
      preheader: 'تلقّينا طلباً لإعادة تعيين كلمة المرور لحسابك',
      bodyHtml,
      ctaUrl: opts.link,
      ctaLabel: 'إعادة تعيين كلمة المرور',
    }),
  })
}

export async function sendGenericEmail(opts: {
  to: string
  subject: string
  heading: string
  body: string
  ctaUrl?: string
  ctaLabel?: string
}) {
  const bodyHtml = `
    <h1 style="margin:0 0 16px 0; color:#0B1B49; font-size:22px; font-weight:700;">${escapeHtml(opts.heading)}</h1>
    <div style="color:#374151; font-size:15px; line-height:1.7;">${opts.body}</div>`
  return sendEmail({
    to: opts.to,
    subject: opts.subject,
    html: htmlShell({
      title: opts.subject,
      preheader: opts.heading,
      bodyHtml,
      ctaUrl: opts.ctaUrl,
      ctaLabel: opts.ctaLabel,
    }),
  })
}

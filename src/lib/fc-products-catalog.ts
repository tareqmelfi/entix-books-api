/**
 * Falcon Core / ENSIDEX product catalog · UX-109
 *
 * Pre-seeded list extracted from Tareq's existing service taxonomy.
 * Categories follow SKU prefix convention:
 *   ADV · Advisory      · ADV-### consulting sessions / strategy
 *   AI  · AI Services   · AI-###  workflow automation / custom GPTs
 *   BRD · Branding      · BRD-### logo / identity packages
 *   CLD · Cloud         · CLD-### managed hosting tiers
 *   CNT · Content       · CNT-### blog / social content
 *   ENT · ENTIX SaaS    · ENT-### Entix Books subscriptions + add-ons
 *   LLC · LLC Services  · LLC-### Wyoming/Delaware LLC formation
 *   PRM · Prompt Eng    · PRM-### prompt writing / GPT development
 *   WEB · Web Design    · WEB-### website packages
 *
 * Use POST /api/products/import to seed.
 */
export interface ProductSeed {
  sku: string
  name: string
  nameAr?: string
  type: 'SERVICE' | 'PACKAGE' | 'SUBSCRIPTION' | 'BUNDLE'
  category: string
  unitPrice: number
  billingCycle?: 'ONE_TIME' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'
  description?: string
}

export const FC_PRODUCTS: ProductSeed[] = [
  // ── Advisory ───────────────────────────────────────────────────────────
  { sku: 'FC-ADV-001-SRV', name: 'Executive Advisory Session (60 min)', nameAr: 'جلسة استشارية تنفيذية (60 دقيقة)', type: 'SERVICE', category: 'ADV', unitPrice: 250 },
  { sku: 'FC-ADV-002-SRV', name: 'KSA Market Entry Consultation',       nameAr: 'استشارة دخول السوق السعودي',         type: 'SERVICE', category: 'ADV', unitPrice: 500 },
  { sku: 'FC-ADV-003-SRV', name: 'US Banking Strategy Session',          nameAr: 'استشارة بنوك الولايات المتحدة',       type: 'SERVICE', category: 'ADV', unitPrice: 350 },
  { sku: 'FC-ADV-004-SRV', name: 'Entity Structure Advisory',            nameAr: 'استشارة هيكلة الكيانات',              type: 'SERVICE', category: 'ADV', unitPrice: 400 },

  // ── AI Services ────────────────────────────────────────────────────────
  { sku: 'FC-AI-001-SRV', name: 'AI Workflow Audit',         nameAr: 'تدقيق سير عمل الذكاء',     type: 'SERVICE', category: 'AI', unitPrice: 500 },
  { sku: 'FC-AI-002-SRV', name: 'Process Automation Setup',  nameAr: 'إعداد أتمتة العمليات',     type: 'SERVICE', category: 'AI', unitPrice: 2500 },
  { sku: 'FC-AI-003-SRV', name: 'Custom AI Integration',     nameAr: 'تكامل ذكاء اصطناعي مخصص', type: 'SERVICE', category: 'AI', unitPrice: 5000 },
  { sku: 'FC-AI-004-SRV', name: 'AI Operations Retainer',    nameAr: 'عقد عمليات الذكاء الشهري', type: 'SUBSCRIPTION', category: 'AI', unitPrice: 3000, billingCycle: 'MONTHLY' },

  // ── Branding ───────────────────────────────────────────────────────────
  { sku: 'FC-BRD-001-SRV', name: 'Logo Design Package',  nameAr: 'باقة تصميم الشعار',  type: 'PACKAGE', category: 'BRD', unitPrice: 1500 },
  { sku: 'FC-BRD-002-SRV', name: 'Full Brand Identity',  nameAr: 'هوية بصرية كاملة',  type: 'PACKAGE', category: 'BRD', unitPrice: 3500 },
  { sku: 'FC-BRD-003-SRV', name: 'Brand Refresh',         nameAr: 'تجديد الهوية',       type: 'PACKAGE', category: 'BRD', unitPrice: 2000 },

  // ── Cloud / Hosting ────────────────────────────────────────────────────
  { sku: 'FC-CLD-001', name: 'Managed Hosting: Starter',    nameAr: 'استضافة مُدارة · مبتدئ', type: 'SUBSCRIPTION', category: 'CLD', unitPrice: 49,  billingCycle: 'MONTHLY' },
  { sku: 'FC-CLD-002', name: 'Managed Hosting: Business',   nameAr: 'استضافة مُدارة · عملي',   type: 'SUBSCRIPTION', category: 'CLD', unitPrice: 99,  billingCycle: 'MONTHLY' },
  { sku: 'FC-CLD-003', name: 'Managed Hosting: Pro',        nameAr: 'استضافة مُدارة · احترافي', type: 'SUBSCRIPTION', category: 'CLD', unitPrice: 199, billingCycle: 'MONTHLY' },
  { sku: 'FC-CLD-004', name: 'Managed Hosting: Enterprise', nameAr: 'استضافة مُدارة · مؤسسي',  type: 'SUBSCRIPTION', category: 'CLD', unitPrice: 499, billingCycle: 'MONTHLY' },

  // ── Content ────────────────────────────────────────────────────────────
  { sku: 'FC-CNT-001-SRV', name: 'Blog Article Package',     nameAr: 'باقة مقالات المدونة',     type: 'PACKAGE', category: 'CNT', unitPrice: 500 },
  { sku: 'FC-CNT-002-SRV', name: 'Social Media Content Pack', nameAr: 'حزمة محتوى السوشيال',   type: 'PACKAGE', category: 'CNT', unitPrice: 300 },
  { sku: 'FC-CNT-003-SRV', name: 'Content Retainer (Monthly)', nameAr: 'عقد محتوى شهري',     type: 'SUBSCRIPTION', category: 'CNT', unitPrice: 2000, billingCycle: 'MONTHLY' },

  // ── ENTIX SaaS ─────────────────────────────────────────────────────────
  { sku: 'FC-ENT-001-SUB', name: 'ENTIX Starter (Monthly)',  nameAr: 'ENTIX المبتدئ (شهري)',  type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 49,    billingCycle: 'MONTHLY' },
  { sku: 'FC-ENT-002-SUB', name: 'ENTIX Growth (Monthly)',   nameAr: 'ENTIX النمو (شهري)',    type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 149,   billingCycle: 'MONTHLY' },
  { sku: 'FC-ENT-003-SUB', name: 'ENTIX Business (Monthly)', nameAr: 'ENTIX الأعمال (شهري)',  type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 299,   billingCycle: 'MONTHLY' },
  { sku: 'FC-ENT-004-SUB', name: 'ENTIX Starter (Annual)',   nameAr: 'ENTIX المبتدئ (سنوي)',  type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 490,   billingCycle: 'ANNUAL' },
  { sku: 'FC-ENT-005-SUB', name: 'ENTIX Growth (Annual)',    nameAr: 'ENTIX النمو (سنوي)',    type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 1490,  billingCycle: 'ANNUAL' },
  { sku: 'FC-ENT-006-SUB', name: 'ENTIX Business (Annual)',  nameAr: 'ENTIX الأعمال (سنوي)',  type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 2990,  billingCycle: 'ANNUAL' },
  { sku: 'FC-ENT-007-SUB', name: 'ENTIX Add-on: Extra User', nameAr: 'ENTIX إضافة · مستخدم',   type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 15,    billingCycle: 'MONTHLY' },
  { sku: 'FC-ENT-008-SUB', name: 'ENTIX Add-on: Extra Entity', nameAr: 'ENTIX إضافة · كيان',  type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 20,    billingCycle: 'MONTHLY' },
  { sku: 'FC-ENT-009-SUB', name: 'ENTIX Add-on: Premium Support', nameAr: 'ENTIX إضافة · دعم مميز', type: 'SUBSCRIPTION', category: 'ENT', unitPrice: 50, billingCycle: 'MONTHLY' },

  // ── LLC Services ───────────────────────────────────────────────────────
  { sku: 'FC-LLC-001-PKG', name: 'Wyoming LLC - Basic Package',    nameAr: 'تأسيس وايومنغ · أساسية',  type: 'PACKAGE', category: 'LLC', unitPrice: 297 },
  { sku: 'FC-LLC-002-PKG', name: 'Wyoming LLC - Standard Package', nameAr: 'تأسيس وايومنغ · قياسية',  type: 'PACKAGE', category: 'LLC', unitPrice: 497 },
  { sku: 'FC-LLC-003-PKG', name: 'Wyoming LLC - Premium Package',  nameAr: 'تأسيس وايومنغ · مميزة',   type: 'PACKAGE', category: 'LLC', unitPrice: 997 },
  { sku: 'FC-LLC-004-PKG', name: 'Delaware LLC Formation',         nameAr: 'تأسيس ديلاوير LLC',       type: 'PACKAGE', category: 'LLC', unitPrice: 597 },
  { sku: 'FC-LLC-010-ADD', name: 'EIN Procurement Service',        nameAr: 'خدمة استخراج EIN',        type: 'SERVICE', category: 'LLC', unitPrice: 149 },
  { sku: 'FC-LLC-011-ADD', name: 'Expedited Processing (3-5 days)', nameAr: 'معالجة سريعة (3-5 أيام)', type: 'SERVICE', category: 'LLC', unitPrice: 75 },
  { sku: 'FC-LLC-012-ADD', name: 'Rush Processing (24-48 hours)',   nameAr: 'معالجة عاجلة (24-48 ساعة)', type: 'SERVICE', category: 'LLC', unitPrice: 150 },
  { sku: 'FC-LLC-013-ADD', name: 'Operating Agreement Customization', nameAr: 'تخصيص اتفاقية تشغيل',  type: 'SERVICE', category: 'LLC', unitPrice: 149 },
  { sku: 'FC-LLC-014-ADD', name: 'Apostille Service',                nameAr: 'خدمة الأبوستيل',         type: 'SERVICE', category: 'LLC', unitPrice: 199 },
  { sku: 'FC-LLC-015-ADD', name: 'Certificate of Good Standing',     nameAr: 'شهادة الحالة الجيدة',    type: 'SERVICE', category: 'LLC', unitPrice: 75 },
  { sku: 'FC-LLC-016-ADD', name: 'Banking Introduction Letter',      nameAr: 'خطاب تعريف بنكي',        type: 'SERVICE', category: 'LLC', unitPrice: 49 },
  { sku: 'FC-LLC-020-REC', name: 'Registered Agent Service (Annual)', nameAr: 'وكيل مسجَّل (سنوي)',   type: 'SUBSCRIPTION', category: 'LLC', unitPrice: 149, billingCycle: 'ANNUAL' },
  { sku: 'FC-LLC-021-REC', name: 'Annual Compliance Package',         nameAr: 'باقة الالتزام السنوي', type: 'SUBSCRIPTION', category: 'LLC', unitPrice: 199, billingCycle: 'ANNUAL' },
  { sku: 'FC-LLC-022-REC', name: 'Virtual Address Service (Annual)',  nameAr: 'عنوان افتراضي (سنوي)', type: 'SUBSCRIPTION', category: 'LLC', unitPrice: 299, billingCycle: 'ANNUAL' },

  // ── Prompt Engineering ────────────────────────────────────────────────
  { sku: 'FC-PRM-001-SRV', name: 'Prompt Writing Session', nameAr: 'جلسة كتابة برومبت',      type: 'SERVICE', category: 'PRM', unitPrice: 150 },
  { sku: 'FC-PRM-002-SRV', name: 'Custom GPT Development', nameAr: 'تطوير GPT مخصص',          type: 'SERVICE', category: 'PRM', unitPrice: 1000 },
  { sku: 'FC-PRM-003-SRV', name: 'Prompt Ops Retainer',    nameAr: 'عقد عمليات البرومبت',     type: 'SUBSCRIPTION', category: 'PRM', unitPrice: 2000, billingCycle: 'MONTHLY' },

  // ── Web Design ─────────────────────────────────────────────────────────
  { sku: 'FC-WEB-001-SRV', name: 'Business Website (5-page)',  nameAr: 'موقع عملي (5 صفحات)',  type: 'PACKAGE', category: 'WEB', unitPrice: 2500 },
  { sku: 'FC-WEB-002-SRV', name: 'Corporate Website (10-page)', nameAr: 'موقع شركة (10 صفحات)', type: 'PACKAGE', category: 'WEB', unitPrice: 4500 },
  { sku: 'FC-WEB-003-SRV', name: 'E-commerce Starter',          nameAr: 'متجر إلكتروني · مبتدئ', type: 'PACKAGE', category: 'WEB', unitPrice: 5000 },
  { sku: 'FC-WEB-004-SRV', name: 'Landing Page Design',         nameAr: 'تصميم صفحة هبوط',      type: 'SERVICE', category: 'WEB', unitPrice: 800 },
  { sku: 'FC-WEB-005-SRV', name: 'Website Redesign',            nameAr: 'إعادة تصميم موقع',     type: 'PACKAGE', category: 'WEB', unitPrice: 3500 },
]

export const CATEGORY_LABELS: Record<string, { en: string; ar: string }> = {
  ADV: { en: 'Advisory',          ar: 'الاستشارات' },
  AI:  { en: 'AI Services',       ar: 'خدمات الذكاء' },
  BRD: { en: 'Branding',          ar: 'الهوية البصرية' },
  CLD: { en: 'Cloud Hosting',     ar: 'الاستضافة السحابية' },
  CNT: { en: 'Content',           ar: 'المحتوى' },
  ENT: { en: 'ENTIX SaaS',        ar: 'اشتراكات ENTIX' },
  LLC: { en: 'LLC Services',      ar: 'خدمات تأسيس الشركات' },
  PRM: { en: 'Prompt Engineering', ar: 'هندسة البرومبت' },
  WEB: { en: 'Web Design',        ar: 'تصميم المواقع' },
}

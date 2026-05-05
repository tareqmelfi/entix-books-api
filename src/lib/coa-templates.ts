/**
 * Chart of Accounts · industry templates
 *
 * Per طارق · "اضف قوالب حسب النشاط مع شجرة بأفضل ممارسة"
 *
 * Each template extends BASE_COA (the universal Saudi-default 20-account starter)
 * with industry-specific sub-accounts. Accounts use a 5-digit code:
 *   1xxxx = Assets       11xxx Cash · 12xxx Receivables · 13xxx Inventory · 14xxx Fixed Assets
 *   2xxxx = Liabilities  21xxx AP · 22xxx Tax · 23xxx Loans · 24xxx Accruals
 *   3xxxx = Equity       31xxx Capital · 32xxx Retained · 33xxx Drawings · 34xxx Shares · 35xxx Reserves
 *   4xxxx = Revenue      41xxx Sales · 42xxx Service · 43xxx Other Income
 *   5xxxx = COGS         51xxx Cost of Goods · 52xxx Direct Labor
 *   6xxxx = Operating    61xxx Salaries · 62xxx Rent · 63xxx Utilities · 64xxx Marketing · 65xxx Admin
 *   7xxxx = Other Exp    71xxx Bank Fees · 72xxx Depreciation · 73xxx Interest
 *
 * Equity sub-categorization (per طارق):
 *   31000  رأس المال (Owner Capital)            · default
 *   31100  رأس مال شريك (Partner Capital)        · for partnerships
 *   31200  حقوق الشركاء (Partners' Equity)       · LLC
 *   32000  الأرباح المحتجزة (Retained Earnings)
 *   33000  المسحوبات (Owner Drawings)
 *   34000  أسهم عادية (Common Shares)            · for joint stock
 *   34100  أسهم ممتازة (Preferred Shares)
 *   34200  أسهم خزينة (Treasury Shares)
 *   34300  علاوة إصدار (Share Premium)
 *   35000  احتياطي قانوني (Statutory Reserve)
 *   35100  احتياطي اختياري (Voluntary Reserve)
 *   35200  احتياطي عام (General Reserve)
 */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'

export interface AccountSeed {
  code: string
  name: string
  nameAr: string
  type: AccountType
  /** Sub-classification · cash · receivable · payable · capital · retained · etc */
  subtype?: string
  /** Code of parent account (if hierarchical) · matched against code in same template */
  parentCode?: string
  description?: string
}

// ─── BASE · universal Saudi-default · 33 accounts with proper hierarchy ──────

export const BASE_COA: AccountSeed[] = [
  // ASSETS · 1xxxx
  { code: '11000', name: 'Cash on Hand', nameAr: 'النقد في الصندوق', type: 'ASSET', subtype: 'cash' },
  { code: '11100', name: 'Bank Accounts', nameAr: 'الحسابات البنكية', type: 'ASSET', subtype: 'bank' },
  { code: '12000', name: 'Accounts Receivable', nameAr: 'الذمم المدينة', type: 'ASSET', subtype: 'receivable' },
  { code: '12100', name: 'Allowance for Doubtful Accounts', nameAr: 'مخصص الديون المشكوك فيها', type: 'ASSET', subtype: 'contra-receivable', parentCode: '12000' },
  { code: '13000', name: 'Inventory', nameAr: 'المخزون', type: 'ASSET', subtype: 'inventory' },
  { code: '14000', name: 'Fixed Assets', nameAr: 'الأصول الثابتة', type: 'ASSET', subtype: 'fixed' },
  { code: '14100', name: 'Accumulated Depreciation', nameAr: 'مجمع الإهلاك', type: 'ASSET', subtype: 'contra-fixed', parentCode: '14000' },
  { code: '15000', name: 'Prepaid Expenses', nameAr: 'مصروفات مدفوعة مقدماً', type: 'ASSET', subtype: 'prepaid' },
  { code: '16000', name: 'VAT Recoverable', nameAr: 'ضريبة القيمة المضافة المسترَدّة', type: 'ASSET', subtype: 'tax-asset' },

  // LIABILITIES · 2xxxx
  { code: '21000', name: 'Accounts Payable', nameAr: 'الذمم الدائنة', type: 'LIABILITY', subtype: 'payable' },
  { code: '22000', name: 'VAT Payable', nameAr: 'ضريبة القيمة المضافة المستحقة', type: 'LIABILITY', subtype: 'tax-payable' },
  { code: '22100', name: 'Withholding Tax Payable', nameAr: 'ضريبة الاستقطاع المستحقة', type: 'LIABILITY', subtype: 'tax-payable' },
  { code: '23000', name: 'Loans Payable', nameAr: 'القروض', type: 'LIABILITY', subtype: 'loan' },
  { code: '23100', name: 'Short-term Loans', nameAr: 'قروض قصيرة الأجل', type: 'LIABILITY', subtype: 'loan-short', parentCode: '23000' },
  { code: '23200', name: 'Long-term Loans', nameAr: 'قروض طويلة الأجل', type: 'LIABILITY', subtype: 'loan-long', parentCode: '23000' },
  { code: '24000', name: 'Accrued Expenses', nameAr: 'مصروفات مستحقة', type: 'LIABILITY', subtype: 'accrual' },
  { code: '24100', name: 'Salaries Payable', nameAr: 'رواتب مستحقة', type: 'LIABILITY', subtype: 'accrual', parentCode: '24000' },
  { code: '24200', name: 'GOSI Payable', nameAr: 'تأمينات اجتماعية مستحقة', type: 'LIABILITY', subtype: 'accrual', parentCode: '24000' },

  // EQUITY · 3xxxx · properly sub-categorized
  { code: '31000', name: 'Owner Capital', nameAr: 'رأس المال', type: 'EQUITY', subtype: 'capital' },
  { code: '31100', name: 'Partners Capital', nameAr: 'رأس مال الشركاء', type: 'EQUITY', subtype: 'capital-partner', parentCode: '31000' },
  { code: '32000', name: 'Retained Earnings', nameAr: 'الأرباح المحتجزة', type: 'EQUITY', subtype: 'retained' },
  { code: '33000', name: 'Owner Drawings', nameAr: 'المسحوبات', type: 'EQUITY', subtype: 'drawings' },
  { code: '34000', name: 'Common Shares', nameAr: 'أسهم عادية', type: 'EQUITY', subtype: 'shares-common' },
  { code: '34100', name: 'Preferred Shares', nameAr: 'أسهم ممتازة', type: 'EQUITY', subtype: 'shares-preferred', parentCode: '34000' },
  { code: '34200', name: 'Treasury Shares', nameAr: 'أسهم خزينة', type: 'EQUITY', subtype: 'shares-treasury', parentCode: '34000' },
  { code: '34300', name: 'Share Premium', nameAr: 'علاوة إصدار', type: 'EQUITY', subtype: 'share-premium', parentCode: '34000' },
  { code: '35000', name: 'Statutory Reserve', nameAr: 'احتياطي قانوني', type: 'EQUITY', subtype: 'reserve' },
  { code: '35100', name: 'Voluntary Reserve', nameAr: 'احتياطي اختياري', type: 'EQUITY', subtype: 'reserve', parentCode: '35000' },

  // INCOME · 4xxxx
  { code: '41000', name: 'Sales Revenue', nameAr: 'إيرادات المبيعات', type: 'REVENUE', subtype: 'sales' },
  { code: '42000', name: 'Service Revenue', nameAr: 'إيرادات الخدمات', type: 'REVENUE', subtype: 'service' },
  { code: '43000', name: 'Other Income', nameAr: 'إيرادات أخرى', type: 'REVENUE', subtype: 'other' },
  { code: '43100', name: 'Interest Income', nameAr: 'إيرادات فوائد', type: 'REVENUE', subtype: 'interest', parentCode: '43000' },
  { code: '43200', name: 'Forex Gain', nameAr: 'أرباح فروقات العملة', type: 'REVENUE', subtype: 'forex', parentCode: '43000' },

  // COGS · 5xxxx
  { code: '51000', name: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', type: 'EXPENSE', subtype: 'cogs' },
  { code: '52000', name: 'Direct Labor', nameAr: 'العمالة المباشرة', type: 'EXPENSE', subtype: 'cogs-labor' },

  // OPERATING EXPENSES · 6xxxx
  { code: '61000', name: 'Salaries', nameAr: 'الرواتب', type: 'EXPENSE', subtype: 'payroll' },
  { code: '61100', name: 'GOSI Employer', nameAr: 'تأمينات صاحب العمل', type: 'EXPENSE', subtype: 'payroll', parentCode: '61000' },
  { code: '62000', name: 'Rent Expense', nameAr: 'مصروف الإيجار', type: 'EXPENSE', subtype: 'rent' },
  { code: '63000', name: 'Utilities', nameAr: 'المرافق', type: 'EXPENSE', subtype: 'utilities' },
  { code: '64000', name: 'Office Supplies', nameAr: 'مستلزمات مكتبية', type: 'EXPENSE', subtype: 'supplies' },
  { code: '65000', name: 'Marketing', nameAr: 'التسويق', type: 'EXPENSE', subtype: 'marketing' },
  { code: '66000', name: 'Travel & Entertainment', nameAr: 'سفر وضيافة', type: 'EXPENSE', subtype: 'travel' },
  { code: '67000', name: 'Professional Fees', nameAr: 'أتعاب مهنية', type: 'EXPENSE', subtype: 'professional' },

  // OTHER EXPENSES · 7xxxx
  { code: '71000', name: 'Bank Fees', nameAr: 'رسوم بنكية', type: 'EXPENSE', subtype: 'bank-fees' },
  { code: '72000', name: 'Depreciation Expense', nameAr: 'مصروف الإهلاك', type: 'EXPENSE', subtype: 'depreciation' },
  { code: '73000', name: 'Interest Expense', nameAr: 'مصروف فوائد', type: 'EXPENSE', subtype: 'interest' },
]

// ─── INDUSTRY-SPECIFIC EXTENSIONS ────────────────────────────────────────────

const SERVICES_EXTRAS: AccountSeed[] = [
  { code: '42100', name: 'Consulting Revenue', nameAr: 'إيرادات الاستشارات', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '42200', name: 'Subscription Revenue', nameAr: 'إيرادات الاشتراكات', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '42300', name: 'Project Revenue', nameAr: 'إيرادات المشاريع', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '67100', name: 'Software Licenses', nameAr: 'تراخيص برمجية', type: 'EXPENSE', subtype: 'software', parentCode: '67000' },
  { code: '67200', name: 'Subcontractor Fees', nameAr: 'أتعاب مقاولين من الباطن', type: 'EXPENSE', subtype: 'subcontractor', parentCode: '67000' },
]

const TRADE_EXTRAS: AccountSeed[] = [
  { code: '13100', name: 'Inventory · Goods for Sale', nameAr: 'مخزون البضائع', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '13200', name: 'Inventory · In Transit', nameAr: 'بضاعة في الطريق', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '41100', name: 'Wholesale Sales', nameAr: 'مبيعات الجملة', type: 'REVENUE', subtype: 'sales', parentCode: '41000' },
  { code: '41200', name: 'Retail Sales', nameAr: 'مبيعات التجزئة', type: 'REVENUE', subtype: 'sales', parentCode: '41000' },
  { code: '41900', name: 'Sales Returns & Discounts', nameAr: 'مرتجعات وخصومات المبيعات', type: 'REVENUE', subtype: 'contra-sales', parentCode: '41000' },
  { code: '51100', name: 'Purchase Discounts', nameAr: 'خصومات المشتريات', type: 'EXPENSE', subtype: 'cogs', parentCode: '51000' },
  { code: '51200', name: 'Freight In', nameAr: 'مصاريف الشحن للداخل', type: 'EXPENSE', subtype: 'cogs', parentCode: '51000' },
]

const MANUFACTURING_EXTRAS: AccountSeed[] = [
  { code: '13300', name: 'Raw Materials', nameAr: 'مواد خام', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '13400', name: 'Work in Progress', nameAr: 'منتجات تحت التشغيل', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '13500', name: 'Finished Goods', nameAr: 'منتجات تامة', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '52100', name: 'Manufacturing Overhead', nameAr: 'تكاليف صناعية غير مباشرة', type: 'EXPENSE', subtype: 'cogs-overhead', parentCode: '52000' },
  { code: '52200', name: 'Factory Rent', nameAr: 'إيجار المصنع', type: 'EXPENSE', subtype: 'cogs-rent', parentCode: '52000' },
  { code: '52300', name: 'Machinery Depreciation', nameAr: 'إهلاك الآلات', type: 'EXPENSE', subtype: 'cogs-depreciation', parentCode: '52000' },
]

const RESTAURANT_EXTRAS: AccountSeed[] = [
  { code: '13600', name: 'Food Inventory', nameAr: 'مخزون الطعام', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '13700', name: 'Beverage Inventory', nameAr: 'مخزون المشروبات', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '41300', name: 'Food Sales', nameAr: 'مبيعات الطعام', type: 'REVENUE', subtype: 'sales', parentCode: '41000' },
  { code: '41400', name: 'Beverage Sales', nameAr: 'مبيعات المشروبات', type: 'REVENUE', subtype: 'sales', parentCode: '41000' },
  { code: '41500', name: 'Delivery Revenue', nameAr: 'إيرادات التوصيل', type: 'REVENUE', subtype: 'sales', parentCode: '41000' },
  { code: '51300', name: 'Food Cost', nameAr: 'تكلفة الطعام', type: 'EXPENSE', subtype: 'cogs', parentCode: '51000' },
  { code: '51400', name: 'Beverage Cost', nameAr: 'تكلفة المشروبات', type: 'EXPENSE', subtype: 'cogs', parentCode: '51000' },
  { code: '61200', name: 'Kitchen Staff Wages', nameAr: 'رواتب الطباخين', type: 'EXPENSE', subtype: 'payroll', parentCode: '61000' },
  { code: '61300', name: 'Service Staff Wages', nameAr: 'رواتب طاقم الخدمة', type: 'EXPENSE', subtype: 'payroll', parentCode: '61000' },
]

const CLINIC_EXTRAS: AccountSeed[] = [
  { code: '13800', name: 'Medical Supplies', nameAr: 'مستلزمات طبية', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '13900', name: 'Pharmaceuticals', nameAr: 'أدوية', type: 'ASSET', subtype: 'inventory', parentCode: '13000' },
  { code: '42400', name: 'Consultation Revenue', nameAr: 'إيرادات الكشف', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '42500', name: 'Procedure Revenue', nameAr: 'إيرادات الإجراءات', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '42600', name: 'Lab/Imaging Revenue', nameAr: 'إيرادات المختبر والأشعة', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '42700', name: 'Insurance Claims Revenue', nameAr: 'إيرادات التأمين الصحي', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '61400', name: 'Doctor Salaries', nameAr: 'رواتب الأطباء', type: 'EXPENSE', subtype: 'payroll', parentCode: '61000' },
  { code: '61500', name: 'Nursing Salaries', nameAr: 'رواتب الممرضين', type: 'EXPENSE', subtype: 'payroll', parentCode: '61000' },
  { code: '67300', name: 'Medical Equipment Maintenance', nameAr: 'صيانة الأجهزة الطبية', type: 'EXPENSE', subtype: 'maintenance', parentCode: '67000' },
]

const ECOMMERCE_EXTRAS: AccountSeed[] = [
  { code: '11200', name: 'Payment Gateway Receivables', nameAr: 'مستحقات بوابات الدفع', type: 'ASSET', subtype: 'receivable', parentCode: '12000' },
  { code: '41600', name: 'Online Sales', nameAr: 'المبيعات الإلكترونية', type: 'REVENUE', subtype: 'sales', parentCode: '41000' },
  { code: '51500', name: 'Shipping Cost', nameAr: 'تكاليف الشحن', type: 'EXPENSE', subtype: 'cogs', parentCode: '51000' },
  { code: '51600', name: 'Payment Processing Fees', nameAr: 'رسوم بوابات الدفع', type: 'EXPENSE', subtype: 'fees', parentCode: '71000' },
  { code: '65100', name: 'Digital Advertising', nameAr: 'إعلانات رقمية', type: 'EXPENSE', subtype: 'marketing', parentCode: '65000' },
  { code: '65200', name: 'Influencer Marketing', nameAr: 'تسويق المؤثرين', type: 'EXPENSE', subtype: 'marketing', parentCode: '65000' },
]

const PRODUCTION_STUDIO_EXTRAS: AccountSeed[] = [
  { code: '14200', name: 'Camera Equipment', nameAr: 'معدات تصوير', type: 'ASSET', subtype: 'fixed', parentCode: '14000' },
  { code: '14300', name: 'Lighting Equipment', nameAr: 'معدات إضاءة', type: 'ASSET', subtype: 'fixed', parentCode: '14000' },
  { code: '14400', name: 'Audio Equipment', nameAr: 'معدات صوت', type: 'ASSET', subtype: 'fixed', parentCode: '14000' },
  { code: '42800', name: 'Production Revenue', nameAr: 'إيرادات الإنتاج', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '42900', name: 'Post-Production Revenue', nameAr: 'إيرادات ما بعد الإنتاج', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '52400', name: 'Talent Fees', nameAr: 'أتعاب الفنانين', type: 'EXPENSE', subtype: 'cogs', parentCode: '52000' },
  { code: '52500', name: 'Location Rent', nameAr: 'إيجار مواقع التصوير', type: 'EXPENSE', subtype: 'cogs', parentCode: '52000' },
  { code: '52600', name: 'Equipment Rental', nameAr: 'تأجير معدات', type: 'EXPENSE', subtype: 'cogs', parentCode: '52000' },
]

const LAW_FIRM_EXTRAS: AccountSeed[] = [
  { code: '12200', name: 'Client Trust Account', nameAr: 'حساب أمانات العملاء', type: 'ASSET', subtype: 'trust', parentCode: '11000' },
  { code: '42100', name: 'Legal Fees', nameAr: 'أتعاب قانونية', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '42200', name: 'Retainer Income', nameAr: 'إيرادات الاتعاب الشهرية', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '42300', name: 'Court Filing Reimbursements', nameAr: 'إيرادات استرداد رسوم محاكم', type: 'REVENUE', subtype: 'reimbursement', parentCode: '42000' },
  { code: '67400', name: 'Court Fees', nameAr: 'رسوم محاكم', type: 'EXPENSE', subtype: 'professional', parentCode: '67000' },
  { code: '67500', name: 'Bar Association Dues', nameAr: 'اشتراكات نقابة المحامين', type: 'EXPENSE', subtype: 'professional', parentCode: '67000' },
]

const REAL_ESTATE_EXTRAS: AccountSeed[] = [
  { code: '14500', name: 'Properties for Sale', nameAr: 'عقارات للبيع', type: 'ASSET', subtype: 'inventory-property', parentCode: '13000' },
  { code: '14600', name: 'Properties for Rent', nameAr: 'عقارات للإيجار', type: 'ASSET', subtype: 'fixed-property', parentCode: '14000' },
  { code: '41700', name: 'Property Sales', nameAr: 'مبيعات عقارات', type: 'REVENUE', subtype: 'sales', parentCode: '41000' },
  { code: '42100', name: 'Rental Income', nameAr: 'إيرادات الإيجار', type: 'REVENUE', subtype: 'rental', parentCode: '42000' },
  { code: '42200', name: 'Brokerage Commission', nameAr: 'عمولات الوساطة', type: 'REVENUE', subtype: 'commission', parentCode: '42000' },
  { code: '42300', name: 'Property Management Fees', nameAr: 'أتعاب إدارة الأملاك', type: 'REVENUE', subtype: 'service', parentCode: '42000' },
  { code: '67600', name: 'Property Maintenance', nameAr: 'صيانة العقارات', type: 'EXPENSE', subtype: 'maintenance', parentCode: '67000' },
]

const CONSTRUCTION_EXTRAS: AccountSeed[] = [
  { code: '12300', name: 'Contracts in Progress', nameAr: 'عقود تحت التنفيذ', type: 'ASSET', subtype: 'wip', parentCode: '13000' },
  { code: '12400', name: 'Retention Receivables', nameAr: 'محتجزات تحت التنفيذ', type: 'ASSET', subtype: 'retention', parentCode: '12000' },
  { code: '24300', name: 'Retention Payables', nameAr: 'محتجزات للموردين', type: 'LIABILITY', subtype: 'retention-payable', parentCode: '24000' },
  { code: '41800', name: 'Construction Revenue', nameAr: 'إيرادات المقاولات', type: 'REVENUE', subtype: 'sales', parentCode: '41000' },
  { code: '52700', name: 'Subcontractor Costs', nameAr: 'تكاليف مقاولين من الباطن', type: 'EXPENSE', subtype: 'cogs', parentCode: '52000' },
  { code: '52800', name: 'Construction Materials', nameAr: 'مواد البناء', type: 'EXPENSE', subtype: 'cogs', parentCode: '52000' },
]

// ─── EXPORT · template registry ──────────────────────────────────────────────

export interface IndustryTemplate {
  id: string
  name: string
  nameAr: string
  description: string
  icon?: string
  extras: AccountSeed[]
}

export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    id: 'services',
    name: 'Services & Consulting',
    nameAr: 'خدمات واستشارات',
    description: 'مكاتب استشارات · تطوير برمجيات · تسويق · تصميم',
    icon: '💼',
    extras: SERVICES_EXTRAS,
  },
  {
    id: 'trade',
    name: 'Trade · Wholesale & Retail',
    nameAr: 'تجارة جملة وتجزئة',
    description: 'متاجر · موزعون · بضائع تامة الصنع',
    icon: '🏪',
    extras: TRADE_EXTRAS,
  },
  {
    id: 'manufacturing',
    name: 'Manufacturing',
    nameAr: 'تصنيع',
    description: 'مصانع · تصنيع منتجات · مواد خام · WIP',
    icon: '🏭',
    extras: MANUFACTURING_EXTRAS,
  },
  {
    id: 'restaurant',
    name: 'Restaurant & F&B',
    nameAr: 'مطعم وأغذية',
    description: 'مطاعم · مقاهي · توصيل · F&B',
    icon: '🍽️',
    extras: RESTAURANT_EXTRAS,
  },
  {
    id: 'clinic',
    name: 'Healthcare · Clinic',
    nameAr: 'عيادة وخدمات صحية',
    description: 'عيادات · مستشفيات · خدمات طبية · تأمين صحي',
    icon: '🏥',
    extras: CLINIC_EXTRAS,
  },
  {
    id: 'ecommerce',
    name: 'E-commerce',
    nameAr: 'تجارة إلكترونية',
    description: 'متاجر إلكترونية · بوابات دفع · شحن · إعلانات رقمية',
    icon: '🛒',
    extras: ECOMMERCE_EXTRAS,
  },
  {
    id: 'production-studio',
    name: 'Production Studio',
    nameAr: 'استوديو إنتاج فني',
    description: 'إنتاج فيديو · إنتاج إعلانات · معدات · مواهب',
    icon: '🎬',
    extras: PRODUCTION_STUDIO_EXTRAS,
  },
  {
    id: 'law-firm',
    name: 'Law Firm',
    nameAr: 'مكتب محاماة',
    description: 'خدمات قانونية · أمانات عملاء · أتعاب · محاكم',
    icon: '⚖️',
    extras: LAW_FIRM_EXTRAS,
  },
  {
    id: 'real-estate',
    name: 'Real Estate',
    nameAr: 'عقارات',
    description: 'بيع · تأجير · وساطة · إدارة أملاك',
    icon: '🏢',
    extras: REAL_ESTATE_EXTRAS,
  },
  {
    id: 'construction',
    name: 'Construction & Contracting',
    nameAr: 'مقاولات وإنشاءات',
    description: 'مقاولات · WIP · محتجزات · مقاولين من الباطن',
    icon: '🏗️',
    extras: CONSTRUCTION_EXTRAS,
  },
]

/** Build the full COA for a given industry · BASE + industry extras · de-duplicated by code */
export function buildCoaForIndustry(industryId: string | null): AccountSeed[] {
  const tpl = INDUSTRY_TEMPLATES.find((t) => t.id === industryId)
  const seen = new Set<string>()
  const out: AccountSeed[] = []
  for (const a of [...BASE_COA, ...(tpl?.extras || [])]) {
    if (!seen.has(a.code)) {
      seen.add(a.code)
      out.push(a)
    }
  }
  return out
}

/**
 * Industry-specific product catalog templates · UX-138
 *
 * Each industry ships with a starter set of products/services that match
 * common operations in that sector. Org owners can pick one (or none) when
 * creating an org or later from Settings → Catalog.
 */

export interface CatalogProduct {
  sku: string
  name: string
  nameAr: string
  type: 'SERVICE' | 'PRODUCT' | 'SUBSCRIPTION' | 'PACKAGE'
  category: string
  unitPrice: number
  taxRate?: number // 0.15 default for KSA
  description?: string
}

export interface IndustryCatalog {
  id: string
  name: string
  nameAr: string
  description: string
  icon: string
  products: CatalogProduct[]
}

// ── Consulting / Advisory ───────────────────────────────────────────────────
const CONSULTING: CatalogProduct[] = [
  { sku: 'CONS-001', name: 'Initial Discovery Call (60 min)', nameAr: 'جلسة استكشاف أولية (60 دقيقة)', type: 'SERVICE', category: 'consulting', unitPrice: 250 },
  { sku: 'CONS-002', name: 'Strategy Session', nameAr: 'جلسة استراتيجية', type: 'SERVICE', category: 'consulting', unitPrice: 750 },
  { sku: 'CONS-003', name: 'Monthly Retainer · Standard', nameAr: 'أتعاب شهرية · أساسي', type: 'SUBSCRIPTION', category: 'consulting', unitPrice: 5000 },
  { sku: 'CONS-004', name: 'Monthly Retainer · Premium', nameAr: 'أتعاب شهرية · بريميوم', type: 'SUBSCRIPTION', category: 'consulting', unitPrice: 12000 },
  { sku: 'CONS-005', name: 'Workshop Facilitation (Half Day)', nameAr: 'تيسير ورشة عمل (نصف يوم)', type: 'SERVICE', category: 'consulting', unitPrice: 4500 },
  { sku: 'CONS-006', name: 'Executive Coaching Package (4 sessions)', nameAr: 'باقة تدريب تنفيذي (٤ جلسات)', type: 'PACKAGE', category: 'consulting', unitPrice: 6000 },
]

// ── Retail / E-commerce ───────────────────────────────────────────────────────
const RETAIL: CatalogProduct[] = [
  { sku: 'RTL-001', name: 'Generic Product · Small', nameAr: 'منتج · صغير', type: 'PRODUCT', category: 'retail', unitPrice: 50 },
  { sku: 'RTL-002', name: 'Generic Product · Medium', nameAr: 'منتج · متوسط', type: 'PRODUCT', category: 'retail', unitPrice: 150 },
  { sku: 'RTL-003', name: 'Generic Product · Large', nameAr: 'منتج · كبير', type: 'PRODUCT', category: 'retail', unitPrice: 350 },
  { sku: 'RTL-DLV', name: 'Local Delivery', nameAr: 'توصيل محلي', type: 'SERVICE', category: 'shipping', unitPrice: 25 },
  { sku: 'RTL-EXP', name: 'Express Delivery', nameAr: 'توصيل سريع', type: 'SERVICE', category: 'shipping', unitPrice: 50 },
  { sku: 'RTL-INST', name: 'Installation Service', nameAr: 'خدمة تركيب', type: 'SERVICE', category: 'service', unitPrice: 200 },
]

// ── Real Estate ──────────────────────────────────────────────────────────────
const REAL_ESTATE: CatalogProduct[] = [
  { sku: 'RE-MGT-A', name: 'Property Management · Apartment', nameAr: 'إدارة عقار · شقة', type: 'SUBSCRIPTION', category: 'management', unitPrice: 500 },
  { sku: 'RE-MGT-V', name: 'Property Management · Villa', nameAr: 'إدارة عقار · فيلا', type: 'SUBSCRIPTION', category: 'management', unitPrice: 1500 },
  { sku: 'RE-MGT-C', name: 'Property Management · Commercial', nameAr: 'إدارة عقار · تجاري', type: 'SUBSCRIPTION', category: 'management', unitPrice: 3000 },
  { sku: 'RE-BRK', name: 'Brokerage Commission (2.5%)', nameAr: 'عمولة وساطة (٢.٥٪)', type: 'SERVICE', category: 'commission', unitPrice: 0 }, // computed
  { sku: 'RE-VAL', name: 'Property Valuation', nameAr: 'تقييم عقاري', type: 'SERVICE', category: 'service', unitPrice: 1500 },
  { sku: 'RE-INSP', name: 'Property Inspection', nameAr: 'فحص عقاري', type: 'SERVICE', category: 'service', unitPrice: 800 },
  { sku: 'RE-MNT', name: 'Maintenance Visit', nameAr: 'زيارة صيانة', type: 'SERVICE', category: 'maintenance', unitPrice: 300 },
]

// ── Veterinary Clinic ────────────────────────────────────────────────────────
const VET_CLINIC: CatalogProduct[] = [
  { sku: 'VET-CON', name: 'General Consultation', nameAr: 'كشف عام', type: 'SERVICE', category: 'medical', unitPrice: 150 },
  { sku: 'VET-VAC', name: 'Vaccination', nameAr: 'تطعيم', type: 'SERVICE', category: 'medical', unitPrice: 200 },
  { sku: 'VET-SUR', name: 'Minor Surgery', nameAr: 'عملية صغرى', type: 'SERVICE', category: 'surgery', unitPrice: 1500 },
  { sku: 'VET-DEN', name: 'Dental Cleaning', nameAr: 'تنظيف أسنان', type: 'SERVICE', category: 'medical', unitPrice: 600 },
  { sku: 'VET-XRY', name: 'X-Ray', nameAr: 'أشعة', type: 'SERVICE', category: 'diagnostic', unitPrice: 250 },
  { sku: 'VET-LAB', name: 'Lab Test', nameAr: 'تحليل مخبري', type: 'SERVICE', category: 'diagnostic', unitPrice: 200 },
  { sku: 'VET-GRM', name: 'Grooming', nameAr: 'تجميل وقص', type: 'SERVICE', category: 'grooming', unitPrice: 200 },
  { sku: 'VET-BRD', name: 'Boarding (Per Night)', nameAr: 'إيواء (الليلة)', type: 'SERVICE', category: 'boarding', unitPrice: 100 },
]

// ── Production / Media ──────────────────────────────────────────────────────
const PRODUCTION: CatalogProduct[] = [
  { sku: 'PRD-VID-S', name: 'Short Video Production (≤30s)', nameAr: 'إنتاج فيديو قصير (≤٣٠ث)', type: 'SERVICE', category: 'video', unitPrice: 5000 },
  { sku: 'PRD-VID-M', name: 'Medium Video Production (1-3 min)', nameAr: 'إنتاج فيديو متوسط (١-٣ د)', type: 'SERVICE', category: 'video', unitPrice: 15000 },
  { sku: 'PRD-VID-L', name: 'Documentary / Long-Form', nameAr: 'إنتاج فيلم وثائقي', type: 'SERVICE', category: 'video', unitPrice: 50000 },
  { sku: 'PRD-PHO', name: 'Photo Shoot Day', nameAr: 'يوم تصوير فوتوغرافي', type: 'SERVICE', category: 'photo', unitPrice: 3500 },
  { sku: 'PRD-EDT', name: 'Video Editing (Per Hour)', nameAr: 'مونتاج فيديو (الساعة)', type: 'SERVICE', category: 'editing', unitPrice: 250 },
  { sku: 'PRD-VFX', name: 'VFX / Motion Graphics', nameAr: 'مؤثرات بصرية / موشن', type: 'SERVICE', category: 'editing', unitPrice: 800 },
  { sku: 'PRD-EVT', name: 'Event Coverage Day', nameAr: 'تغطية فعالية', type: 'SERVICE', category: 'events', unitPrice: 6000 },
]

// ── Education / Training ─────────────────────────────────────────────────────
const EDUCATION: CatalogProduct[] = [
  { sku: 'EDU-CRS-OL', name: 'Online Course Enrollment', nameAr: 'اشتراك دورة أونلاين', type: 'SUBSCRIPTION', category: 'course', unitPrice: 500 },
  { sku: 'EDU-CRS-PR', name: 'In-Person Course', nameAr: 'دورة حضورية', type: 'SERVICE', category: 'course', unitPrice: 2500 },
  { sku: 'EDU-CRT', name: 'Certificate Issuance', nameAr: 'إصدار شهادة', type: 'SERVICE', category: 'cert', unitPrice: 100 },
  { sku: 'EDU-TUT', name: 'Private Tutoring (Per Hour)', nameAr: 'دروس خصوصية (الساعة)', type: 'SERVICE', category: 'tutoring', unitPrice: 200 },
  { sku: 'EDU-WSH', name: 'Workshop · Half Day', nameAr: 'ورشة · نصف يوم', type: 'SERVICE', category: 'workshop', unitPrice: 1500 },
  { sku: 'EDU-CMP', name: 'Bootcamp / Camp', nameAr: 'معسكر تدريبي', type: 'PACKAGE', category: 'bootcamp', unitPrice: 8000 },
]

// ── Saas (own product) ──────────────────────────────────────────────────────
const SAAS: CatalogProduct[] = [
  { sku: 'SAAS-FREE', name: 'Free Plan', nameAr: 'خطة مجانية', type: 'SUBSCRIPTION', category: 'plan', unitPrice: 0 },
  { sku: 'SAAS-PRO', name: 'Pro Plan (Monthly)', nameAr: 'خطة احترافية (شهري)', type: 'SUBSCRIPTION', category: 'plan', unitPrice: 99 },
  { sku: 'SAAS-PRO-Y', name: 'Pro Plan (Yearly)', nameAr: 'خطة احترافية (سنوي)', type: 'SUBSCRIPTION', category: 'plan', unitPrice: 999 },
  { sku: 'SAAS-BIZ', name: 'Business Plan', nameAr: 'خطة الأعمال', type: 'SUBSCRIPTION', category: 'plan', unitPrice: 299 },
  { sku: 'SAAS-ENT', name: 'Enterprise Plan', nameAr: 'خطة المؤسسات', type: 'SUBSCRIPTION', category: 'plan', unitPrice: 999 },
  { sku: 'SAAS-ADD-USR', name: 'Additional User Seat', nameAr: 'مستخدم إضافي', type: 'SUBSCRIPTION', category: 'addon', unitPrice: 15 },
  { sku: 'SAAS-IMPL', name: 'Implementation Services', nameAr: 'خدمات تطبيق', type: 'SERVICE', category: 'service', unitPrice: 5000 },
]

export const INDUSTRY_CATALOGS: IndustryCatalog[] = [
  { id: 'consulting', name: 'Consulting & Advisory', nameAr: 'استشارات', description: '6 خدمات: جلسات، استراتيجية، أتعاب شهرية، ورش، تدريب تنفيذي', icon: '💼', products: CONSULTING },
  { id: 'retail',     name: 'Retail / E-commerce',   nameAr: 'تجزئة',    description: '6 منتجات/خدمات: أحجام منتج، توصيل، تركيب', icon: '🛍️', products: RETAIL },
  { id: 'real_estate',name: 'Real Estate',           nameAr: 'عقارات',    description: '7 خدمات: إدارة شقة/فيلا/تجاري، عمولات، تقييم، فحص، صيانة', icon: '🏢', products: REAL_ESTATE },
  { id: 'vet_clinic', name: 'Veterinary Clinic',     nameAr: 'عيادة بيطرية', description: '8 خدمات: كشوفات، تطعيمات، عمليات، أسنان، أشعة، تحليل، تجميل، إيواء', icon: '🐾', products: VET_CLINIC },
  { id: 'production', name: 'Media Production',      nameAr: 'إنتاج فني',  description: '7 خدمات: فيديو قصير/متوسط/طويل، تصوير، مونتاج، VFX، فعاليات', icon: '🎬', products: PRODUCTION },
  { id: 'education',  name: 'Education & Training',  nameAr: 'تعليم وتدريب', description: '6 خدمات: دورات أونلاين/حضوري، شهادات، دروس خصوصية، ورش، معسكرات', icon: '🎓', products: EDUCATION },
  { id: 'saas',       name: 'SaaS Product',          nameAr: 'منتج SaaS', description: '7 خطط: مجاني/Pro/Business/Enterprise + مقاعد إضافية + تطبيق', icon: '💻', products: SAAS },
]

export function getCatalogById(id: string): IndustryCatalog | null {
  return INDUSTRY_CATALOGS.find(c => c.id === id) || null
}

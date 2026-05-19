import { createRequire } from 'node:module'
import sharp from 'sharp'

const require = createRequire(import.meta.url)

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
}

export type NormalizedDocumentFile = {
  fileBase64: string
  mimeType: string
  fileName?: string
  warnings: string[]
  converted: boolean
  error?: string
}

export function inferMimeType(mimeType?: string | null, fileName?: string | null): string {
  const clean = (mimeType || '').trim().toLowerCase()
  if (clean && clean !== 'application/octet-stream') return clean
  const ext = (fileName || '').toLowerCase().split('.').pop() || ''
  return IMAGE_MIME_BY_EXT[ext] || clean || 'application/octet-stream'
}

export function isImageMime(mimeType: string): boolean {
  return inferMimeType(mimeType).startsWith('image/')
}

export function isHeicLike(mimeType: string, fileName?: string | null): boolean {
  const mime = inferMimeType(mimeType, fileName)
  return mime === 'image/heic' || mime === 'image/heif' || /\.(heic|heif)$/i.test(fileName || '')
}

export async function normalizeImageForVision(input: {
  fileBase64: string
  mimeType?: string | null
  fileName?: string | null
}): Promise<NormalizedDocumentFile> {
  const mimeType = inferMimeType(input.mimeType, input.fileName)
  const base = stripDataUrl(input.fileBase64)
  const passthrough: NormalizedDocumentFile = {
    fileBase64: base,
    mimeType,
    fileName: input.fileName || undefined,
    warnings: [],
    converted: false,
  }

  if (!mimeType.startsWith('image/')) return passthrough

  try {
    let inputBuffer = Buffer.from(base, 'base64')
    if (!inputBuffer.length) {
      return { ...passthrough, error: 'ملف الصورة فارغ أو غير قابل للقراءة' }
    }
    const convertedFromHeic = isHeicLike(mimeType, input.fileName)
    if (convertedFromHeic) {
      inputBuffer = await convertHeicToJpeg(inputBuffer)
    }

    const output = await sharp(inputBuffer, {
      failOn: 'none',
      limitInputPixels: 120_000_000,
    })
      .rotate()
      .resize({
        width: 2200,
        height: 3200,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer()

    return {
      fileBase64: output.toString('base64'),
      mimeType: 'image/jpeg',
      fileName: toJpegName(input.fileName || 'document'),
      warnings: [convertedFromHeic
        ? 'تم تحويل صورة HEIC من الآيفون إلى JPG وتجهيزها قبل القراءة.'
        : 'تم تجهيز الصورة قبل القراءة: تحويل إلى JPG، تدوير تلقائي، وتصغير الحجم بدون حذف تفاصيل الفاتورة.'],
      converted: true,
    }
  } catch (e: any) {
    if (isHeicLike(mimeType, input.fileName)) {
      return {
        ...passthrough,
        error: 'تعذر تحويل صورة HEIC في السيرفر. جرّب رفع JPG/PNG مؤقتاً أو أعد تصوير الإيصال من داخل المتصفح.',
      }
    }
    return {
      ...passthrough,
      warnings: ['تعذر تجهيز الصورة تلقائياً، تم إرسالها للقراءة كما هي.'],
    }
  }
}

function stripDataUrl(value: string): string {
  const idx = value.indexOf('base64,')
  return idx >= 0 ? value.slice(idx + 'base64,'.length) : value
}

function toJpegName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '') + '.jpg'
}

async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  const convert = require('heic-convert') as (opts: {
    buffer: Buffer
    format: 'JPEG' | 'PNG'
    quality?: number
  }) => Promise<ArrayBuffer | Uint8Array | Buffer>
  const output = await convert({ buffer, format: 'JPEG', quality: 0.9 })
  return Buffer.from(output as any)
}

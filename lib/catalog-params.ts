// Browse Groups: parsing and validation of the catalog's URL parameters. Pure (no data access), so
// it can be tested offline. Unknown or malformed values are ignored rather than trusted, and the
// page size is clamped, so a hand-edited URL can never produce an unbounded or invalid query.

export const PAGE_SIZE_DEFAULT = 12
export const PAGE_SIZE_MIN = 6
export const PAGE_SIZE_MAX = 24
export const SEARCH_MAX_LENGTH = 80

export const DAYS = [
  { value: 'mon', label: 'Monday' }, { value: 'tue', label: 'Tuesday' }, { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' }, { value: 'fri', label: 'Friday' }, { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' },
] as const

export const TIMES = [
  { value: 'am', label: 'Morning' }, { value: 'pm', label: 'Afternoon' }, { value: 'eve', label: 'Evening' },
] as const

export const FORMATS = [
  { value: 'in_person', label: 'In person' }, { value: 'online', label: 'Online' },
] as const

// Values of app.grp.life_stage_focus (the same vocabulary as the member's life stage).
export const STAGES = [
  { value: 'single', label: 'Single' }, { value: 'married_no_kids', label: 'Married, no kids' },
  { value: 'young_kids', label: 'Young kids' }, { value: 'school_age_kids', label: 'School-age kids' },
  { value: 'teens', label: 'Teens' }, { value: 'empty_nest', label: 'Empty nest' }, { value: 'retired', label: 'Retired' },
] as const

export type CatalogFilters = {
  q: string
  day: string | null
  time: string | null
  format: string | null
  stage: string | null
  childcare: boolean
  open: boolean
}

export type CatalogParams = CatalogFilters & {
  page: number
  pageSize: number
  /** True when something in the URL was not understood and had to be ignored. */
  ignored: boolean
}

type Raw = Record<string, string | string[] | undefined>

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const oneOf = <T extends { value: string }>(options: readonly T[], v: string | undefined) =>
  options.find((o) => o.value === v)?.value ?? null

export function parseCatalogParams(raw: Raw): CatalogParams {
  let ignored = false
  const pick = <T extends { value: string }>(key: string, options: readonly T[]) => {
    const v = first(raw[key])?.trim()
    if (!v) return null
    const hit = oneOf(options, v)
    if (!hit) ignored = true
    return hit
  }
  const flag = (key: string) => {
    const v = first(raw[key])
    if (v === undefined || v === '') return false
    if (v === '1') return true
    ignored = true
    return false
  }
  const int = (key: string, fallback: number) => {
    const v = first(raw[key])
    if (v === undefined || v === '') return fallback
    if (!/^\d{1,6}$/.test(v)) { ignored = true; return fallback }
    return Number(v)
  }

  let q = (first(raw.q) ?? '').replace(/\s+/g, ' ').trim()
  if (q.length > SEARCH_MAX_LENGTH) { q = q.slice(0, SEARCH_MAX_LENGTH); ignored = true }

  const size = int('size', PAGE_SIZE_DEFAULT)
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, size))
  if (pageSize !== size) ignored = true
  const page = Math.max(1, int('page', 1))

  return {
    q, day: pick('day', DAYS), time: pick('time', TIMES), format: pick('format', FORMATS), stage: pick('stage', STAGES),
    childcare: flag('childcare'), open: flag('open'), page, pageSize, ignored,
  }
}

export function hasActiveFilters(p: CatalogFilters): boolean {
  return Boolean(p.q || p.day || p.time || p.format || p.stage || p.childcare || p.open)
}

/** Query string for a catalog page. Defaults are omitted so URLs stay short and shareable. */
export function catalogQuery(p: CatalogFilters & { page?: number; pageSize?: number }): string {
  const s = new URLSearchParams()
  if (p.q) s.set('q', p.q)
  if (p.day) s.set('day', p.day)
  if (p.time) s.set('time', p.time)
  if (p.format) s.set('format', p.format)
  if (p.stage) s.set('stage', p.stage)
  if (p.childcare) s.set('childcare', '1')
  if (p.open) s.set('open', '1')
  if (p.pageSize && p.pageSize !== PAGE_SIZE_DEFAULT) s.set('size', String(p.pageSize))
  if (p.page && p.page > 1) s.set('page', String(p.page))
  const out = s.toString()
  return out ? `?${out}` : ''
}

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import {
  catalogQuery, DAYS, FORMATS, hasActiveFilters, STAGES, TIMES, type CatalogFilters,
} from '@/lib/catalog-params'

// Browse Groups controls. Plain HTML: a GET form and ordinary links, so search, filters and paging
// work without JavaScript or hover, are keyboard accessible, and can never trigger a recommendation
// (nothing here is a server action; the URL is the only state).

const field = 'w-full rounded-lg border border-[#dce5da] bg-white px-3 py-2 text-sm text-[#26382b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9eb99f]'
const label = 'mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-[#718b70]'

function Select({ id, name, text, options, value }: {
  id: string; name: string; text: string; options: readonly { value: string; label: string }[]; value: string | null
}) {
  return (
    <div>
      <label htmlFor={id} className={label}>{text}</label>
      <select id={id} name={name} defaultValue={value ?? ''} className={field}>
        <option value="">Any</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

export function CatalogFilterForm({ filters }: { filters: CatalogFilters }) {
  return (
    <form method="get" action="/member" role="search" aria-label="Search and filter groups" className="rounded-2xl border border-[#e1e8df] bg-white p-5">
      <div>
        <label htmlFor="catalog-q" className={label}>Search groups</label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#849087]" />
          <input id="catalog-q" name="q" type="search" maxLength={80} defaultValue={filters.q}
            placeholder="A name or a word in the description" className={`${field} pl-9`} />
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select id="catalog-day" name="day" text="Day" options={DAYS} value={filters.day} />
        <Select id="catalog-time" name="time" text="Time of day" options={TIMES} value={filters.time} />
        <Select id="catalog-format" name="format" text="Format" options={FORMATS} value={filters.format} />
        <Select id="catalog-stage" name="stage" text="Life stage" options={STAGES} value={filters.stage} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-[#36463b]">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="childcare" value="1" defaultChecked={filters.childcare} className="size-4 accent-[#3e644b]" /> Childcare available
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="open" value="1" defaultChecked={filters.open} className="size-4 accent-[#3e644b]" /> Open to new members
        </label>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button type="submit" className="rounded-md border border-[#3e644b] px-4 py-2 text-sm font-medium text-[#3e644b] hover:bg-[#f0f6ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9eb99f]">Apply</button>
        {hasActiveFilters(filters) && (
          <Link href="/member" className="text-sm font-semibold text-[#55745c] underline underline-offset-4">Clear all</Link>
        )}
      </div>
    </form>
  )
}

export function CatalogPagination({ filters, page, pageSize, pageCount }: {
  filters: CatalogFilters; page: number; pageSize: number; pageCount: number
}) {
  if (pageCount <= 1) return null
  const href = (p: number) => `/member${catalogQuery({ ...filters, page: p, pageSize })}`
  const link = 'inline-flex items-center gap-1 rounded-md border border-[#dce5da] bg-white px-3 py-2 text-sm font-medium text-[#36463b] hover:bg-[#f0f6ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9eb99f]'
  const off = 'inline-flex items-center gap-1 rounded-md border border-[#edf0eb] px-3 py-2 text-sm text-[#a5ada6]'
  return (
    <nav aria-label="Pagination" className="mt-8 flex items-center justify-between gap-4">
      {page > 1
        ? <Link href={href(page - 1)} rel="prev" className={link}><ChevronLeft className="size-4" aria-hidden /> Previous</Link>
        : <span className={off} aria-disabled="true"><ChevronLeft className="size-4" aria-hidden /> Previous</span>}
      <span className="text-sm text-[#69736b]">Page {page} of {pageCount}</span>
      {page < pageCount
        ? <Link href={href(page + 1)} rel="next" className={link}>Next <ChevronRight className="size-4" aria-hidden /></Link>
        : <span className={off} aria-disabled="true">Next <ChevronRight className="size-4" aria-hidden /></span>}
    </nav>
  )
}

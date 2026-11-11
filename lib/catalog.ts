import 'server-only'
import { withPersona } from '@/lib/db'
import type { CatalogParams } from '@/lib/catalog-params'

// Browse Groups: the member-facing public group catalog (Journey 1).
//
// Reads ONLY through app.group_card(), the public card function (security definer, no coordinates
// or addresses, no per-viewer data), and returns exactly the fields a recommendation card carries,
// so a catalog card and a recommended card are the same public group card. Nothing here touches
// recommendation, score, shortlist or model data, and nothing here calls the model. Pagination and
// filtering happen in the database; the browser never receives the full catalog.

/** The public card contract. Identical to the fields of a recommended group, minus its position. */
export type CatalogGroup = {
  group_id: string
  name: string
  description: string
  tags: string[] | null
  meeting_slot: string
  is_online: boolean
  childcare: boolean
  open_seats: number
  area_label: string
}

export type CatalogPage = {
  /** Every group in the catalog, ignoring filters (the number that frames the discovery problem). */
  total: number
  /** Groups matching the current search and filters. */
  matching: number
  page: number
  pageSize: number
  pageCount: number
  groups: CatalogGroup[]
}

const COLUMNS = 'group_id, name, description, tags, meeting_slot, is_online, childcare, open_seats, area_label'

/** Builds the WHERE clause. Every value is a bound parameter; nothing from the URL is interpolated. */
export function catalogWhere(p: Omit<CatalogParams, 'page' | 'pageSize' | 'ignored'>): { sql: string; values: unknown[] } {
  const where: string[] = []
  const values: unknown[] = []
  const add = (clause: string, v: unknown) => { values.push(v); where.push(clause.replaceAll('$$', `$${values.length}`)) }

  if (p.q) add('(strpos(lower(name), lower($$)) > 0 or strpos(lower(description), lower($$)) > 0)', p.q)
  if (p.day) add("split_part(meeting_slot, '_', 1) = $$", p.day)
  if (p.time) add("split_part(meeting_slot, '_', 2) = $$", p.time)
  if (p.format) where.push(p.format === 'online' ? 'is_online' : 'not is_online')
  if (p.stage) add('life_stage_focus = $$', p.stage)
  if (p.childcare) where.push('childcare')
  // "Open to new members" matches what the group page accepts requests for: open or forming, with a seat.
  if (p.open) where.push("status in ('open', 'forming') and open_seats > 0")
  return { sql: where.length ? `where ${where.join(' and ')}` : '', values }
}

export async function getCatalogPage(personKey: string, params: CatalogParams): Promise<CatalogPage> {
  const { sql, values } = catalogWhere(params)
  return withPersona(personKey, async (db) => {
    const total = (await db.query<{ n: number }>('select count(*)::int as n from app.group_card()')).rows[0].n
    const matching = (await db.query<{ n: number }>(`select count(*)::int as n from app.group_card() ${sql}`, values)).rows[0].n
    const pageCount = Math.max(1, Math.ceil(matching / params.pageSize))
    const page = Math.min(params.page, pageCount) // a page past the end shows the last page
    const rows = (await db.query<CatalogGroup>(
      `select ${COLUMNS} from app.group_card() ${sql}
       order by lower(name), group_id
       limit ${params.pageSize} offset ${(page - 1) * params.pageSize}`, values)).rows
    return { total, matching, page, pageSize: params.pageSize, pageCount, groups: rows }
  })
}

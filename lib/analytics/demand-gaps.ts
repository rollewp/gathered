import 'server-only'
import { withPersona } from '@/lib/db'

// Manager "Group demand gaps": reads the small aggregate that the Databricks refresh job writes to
// app.demand_gap. Aggregates only (no people, no names). Row-level security lets only the Manager
// role read the table; any other persona gets zero rows. The page never scans engagement events:
// the population analysis ran in Databricks.

export type DemandGap = {
  life_stage: string
  available_slot: string
  opted_in_ungrouped_count: number
  serving_group_count: number
  available_seat_count: number
  people_per_open_seat: number | null
  people_without_reachable_group: number
  gap_classification: 'No current group' | 'High demand' | 'Limited reach'
  gap_rank: number
}

export type DemandGapSummary = {
  gaps: DemandGap[]
  /** All gap cohorts, of which `gaps` is the top slice shown. */
  totalGapCohorts: number
  cohortsAnalyzed: number
  asOf: string | null
  computedAt: string | null
}

const TOP = 5

export async function getDemandGaps(personKey: string): Promise<DemandGapSummary> {
  return withPersona(personKey, async (db) => {
    const gaps = (await db.query<DemandGap>(
      `select life_stage, available_slot, opted_in_ungrouped_count, serving_group_count, available_seat_count,
              people_per_open_seat::float8 as people_per_open_seat, people_without_reachable_group,
              gap_classification, gap_rank
         from app.demand_gap where gap_rank is not null order by gap_rank limit $1`, [TOP])).rows
    const meta = (await db.query<{ cohorts: number; gaps: number; as_of: string | null; computed_at: string | null }>(
      `select count(*)::int as cohorts, count(gap_rank)::int as gaps, max(as_of_date)::text as as_of, max(computed_at)::text as computed_at
         from app.demand_gap`)).rows[0]
    return { gaps, totalGapCohorts: meta.gaps, cohortsAnalyzed: meta.cohorts, asOf: meta.as_of, computedAt: meta.computed_at }
  })
}

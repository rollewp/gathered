// Presentation helpers for member-facing group information. Pure formatting, no data access.

export type GroupCardRow = {
  group_id: string
  name: string
  description: string
  meeting_slot: string
  frequency: string | null
  is_online: boolean
  capacity_max: number
  childcare: boolean
  status: string
  tags: string[] | null
  open_seats: number
  area_label: string
}

export type GroupView = {
  id: string
  name: string
  description: string
  tags: string[]
  slot: string
  area: string
  openSeats: number
  childcare: string
}

const DAYS: Record<string, string> = {
  mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays', thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays', sun: 'Sundays',
}
const PARTS: Record<string, string> = { am: 'mornings', pm: 'afternoons', eve: 'evenings' }

/** 'tue_am' -> 'Tuesdays · mornings'. Unknown values are shown as-is rather than hidden. */
export function slotLabel(slot: string | null | undefined): string {
  if (!slot) return 'Time to be confirmed'
  const [d, p] = slot.split('_')
  return DAYS[d] && PARTS[p] ? `${DAYS[d]} · ${PARTS[p]}` : slot
}

/** 'new_to_faith' -> 'New to faith'. */
export function tagLabel(tag: string): string {
  const t = tag.replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

const LIFE_STAGES: Record<string, string> = {
  single: 'Single', married_no_kids: 'Married, no kids', young_kids: 'Young kids', school_age_kids: 'School-age kids',
  teens: 'Teens', empty_nest: 'Empty nest', retired: 'Retired',
}
const GROUP_PREFS: Record<string, string> = { men: 'Men', women: 'Women', mixed: 'Mixed', couples: 'Couples' }
export const lifeStageLabel = (v: string | null) => (v ? LIFE_STAGES[v] ?? v : null)
export const groupPrefLabel = (v: string | null) => (v ? GROUP_PREFS[v] ?? v : null)

type CardFields = Pick<GroupCardRow, 'group_id' | 'name' | 'description' | 'meeting_slot' | 'is_online' | 'childcare' | 'tags' | 'open_seats' | 'area_label'>

export function toGroupView(c: CardFields): GroupView {
  return {
    id: c.group_id,
    name: c.name,
    description: c.description,
    tags: (c.tags ?? []).map(tagLabel),
    slot: slotLabel(c.meeting_slot),
    area: c.is_online ? 'Online' : c.area_label,
    openSeats: c.open_seats,
    childcare: c.childcare ? 'Childcare available' : 'No childcare',
  }
}

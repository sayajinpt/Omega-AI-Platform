/** IANA timezone for the machine running Omega (e.g. Europe/Lisbon). */
export function getSystemTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && tz.length > 0 ? tz : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Common place names → IANA zones (extend as needed). */
const PLACE_TIME_ZONES: Record<string, string> = {
  portugal: 'Europe/Lisbon',
  lisbon: 'Europe/Lisbon',
  london: 'Europe/London',
  uk: 'Europe/London',
  england: 'Europe/London',
  paris: 'Europe/Paris',
  france: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  germany: 'Europe/Berlin',
  rome: 'Europe/Rome',
  italy: 'Europe/Rome',
  madrid: 'Europe/Madrid',
  spain: 'Europe/Madrid',
  tokyo: 'Asia/Tokyo',
  japan: 'Asia/Tokyo',
  beijing: 'Asia/Shanghai',
  china: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  india: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  dubai: 'Asia/Dubai',
  uae: 'Asia/Dubai',
  sydney: 'Australia/Sydney',
  australia: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  'new york': 'America/New_York',
  nyc: 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  chicago: 'America/Chicago',
  denver: 'America/Denver',
  vancouver: 'America/Vancouver',
  toronto: 'America/Toronto',
  canada: 'America/Toronto',
  brazil: 'America/Sao_Paulo',
  'sao paulo': 'America/Sao_Paulo',
  mexico: 'America/Mexico_City',
  'mexico city': 'America/Mexico_City',
  utc: 'UTC',
  gmt: 'UTC'
}

const REMOTE_PLACE_RE = /\b(?:in|at|for)\s+([a-z][a-z0-9\s.,'()-]{1,48})/i

function normalizePlace(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?.!,]+$/, '')
}

/**
 * When the user asks for time in another city/country, return an IANA zone if known.
 * Returns null for "here/local" or unrecognized places (model may pass tz itself).
 */
export function inferTimezoneFromQuery(query: string): string | null {
  const q = query.trim()
  if (!q) return null
  if (/\b(?:here|local|my\s+(?:time\s+)?zone|this\s+(?:computer|machine|pc))\b/i.test(q)) {
    return null
  }
  if (!/\b(?:time|date|clock|hour)\b/i.test(q)) return null
  const m = q.match(REMOTE_PLACE_RE)
  if (!m?.[1]) return null
  const place = normalizePlace(m[1])
  if (!place || /\b(?:here|local)\b/.test(place)) return null
  if (PLACE_TIME_ZONES[place]) return PLACE_TIME_ZONES[place]
  // "New York City" → try without trailing words
  const words = place.split(' ')
  for (let n = words.length; n >= 1; n--) {
    const sub = words.slice(0, n).join(' ')
    if (PLACE_TIME_ZONES[sub]) return PLACE_TIME_ZONES[sub]
  }
  return null
}

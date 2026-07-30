// formatElapsed renders a live duration compactly, in the two largest units that
// still say something: "12s", "1m 05s", "2h 05m", "3d 04h". Each step drops the
// unit below - at hours, a ticking seconds field is noise, and it would make the
// label jitter in width once a minute for no information.
//
// It keeps climbing rather than saturating at minutes: a runner (or an artifact
// generation) that has been going for hours is exactly the case where the label
// matters, and "825127m 50s" is unreadable where "573d 12h" is not.
export function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

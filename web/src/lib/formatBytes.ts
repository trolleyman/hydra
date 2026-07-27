// formatBytes renders a human size. Bytes are spelled out ("123 bytes");
// larger sizes use KB/MB. Shared by the repository browser and
// the artifact download tiles.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

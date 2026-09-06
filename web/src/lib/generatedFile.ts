// Files that are normally machine-owned rather than reviewed line by line.
// Paths cover the windowed-diff case; when line one is available, conventional
// generator banners catch machine-owned outputs without a special filename.
const GENERATED_FILENAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'flake.lock',
  'gemfile.lock',
  'go.sum',
  'mix.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'package.resolved',
  'packages.lock.json',
  'pdm.lock',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
])

const GENERATED_PATH_PARTS = new Set([
  'generated',
  'gen',
])

export function isGeneratedFile(path: string, head?: string | null): boolean {
  const parts = path.toLowerCase().split('/')
  const filename = parts.at(-1) ?? ''
  const banner = head?.slice(0, 512).toLowerCase() ?? ''
  if (/(?:auto(?:matically)?[- ]generated|@generated|code generated.*do not edit|generated.*do not edit)/s.test(banner)) return true
  if (GENERATED_FILENAMES.has(filename)) return true
  if (parts.slice(0, -1).some((part) => GENERATED_PATH_PARTS.has(part))) return true
  return (
    /(?:^|[._-])generated\.[^.]+$/.test(filename)
    || /(?:^|[._-])gen\.[^.]+$/.test(filename)
    || /\.g\.dart$/.test(filename)
    || /\.pb\.(?:go|cc|h|py|rb|php|cs|ts|js)$/.test(filename)
    || /\.designer\.cs$/.test(filename)
  )
}

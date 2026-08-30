import { SquareArrowRight, SquareDot, SquareMinus, SquarePlus } from 'lucide-react'

export function ChangeTypeIcon({
  type,
  className = 'w-3.5 h-3.5',
  bright = false,
}: {
  type: string
  className?: string
  bright?: boolean
}) {
  const cls = `${className} shrink-0`
  switch (type) {
    case 'added':
    case 'untracked':
    case 'copied':
      return <SquarePlus aria-label={type} className={`${cls} ${bright ? 'text-green-400' : 'text-green-600 dark:text-green-400'}`} />
    case 'deleted':
    case 'removed':
      return <SquareMinus aria-label={type} className={`${cls} ${bright ? 'text-red-400' : 'text-red-600 dark:text-red-400'}`} />
    case 'modified':
    case 'conflicted':
      return <SquareDot aria-label={type} className={`${cls} ${bright ? 'text-amber-400' : 'text-amber-600 dark:text-amber-400'}`} />
    case 'renamed':
      return <SquareArrowRight aria-label={type} className={`${cls} ${bright ? 'text-cyan-400' : 'text-cyan-600 dark:text-cyan-400'}`} />
    default:
      return null
  }
}

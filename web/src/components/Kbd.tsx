// A keycap. One component for every keyboard hint in the UI - the shortcuts
// overlay's table, and the tooltips that name a modifier - so that a key looks
// like a key wherever it turns up, instead of being a keycap in one place and
// "(Alt: ...)" in prose somewhere else.
//
// The shadow is what makes it read as a physical cap rather than a bordered
// chip: 1px right, 2px down, no blur to speak of, so the light is coming from
// the top-left the way it does everywhere else in the UI. It is deliberately
// tiny - a keycap sits inside a line of text, and anything heavier turns a
// hint into a button.
//
// Both surfaces it renders on (the modal panel and the tooltip box) are
// white/gray-800, so one pair of colours covers both.

type KbdSize = 'sm' | 'md'

// sm is for a tooltip's hint line, where the cap sits under a sentence and must
// not out-shout it; md is the overlay's table, where the caps are the content.
const SIZE: Record<KbdSize, string> = {
  sm: 'min-w-[1.125rem] h-[1.125rem] px-1 text-4xs',
  md: 'min-w-[1.5rem] h-6 px-1.5 text-2xs',
}

export function Kbd({ children, size = 'md' }: { children: React.ReactNode; size?: KbdSize }) {
  return (
    <kbd
      className={
        'inline-flex shrink-0 items-center justify-center rounded-md border border-gray-200 dark:border-gray-600 ' +
        'bg-gray-50 dark:bg-gray-900 font-medium text-gray-500 dark:text-gray-400 ' +
        'shadow-[1px_2px_0_-1px_rgb(0_0_0/0.10),1px_2px_3px_-1px_rgb(0_0_0/0.12)] ' +
        'dark:shadow-[1px_2px_0_-1px_rgb(0_0_0/0.45),1px_2px_3px_-1px_rgb(0_0_0/0.5)] ' +
        SIZE[size]
      }
    >
      <span className="relative top-px leading-none">{children}</span>
    </kbd>
  )
}

// A whole shortcut - its keys, and optionally what they do when they differ
// from the control's main action ("Alt / restart without rebuilding"). Used on
// its own line under a tooltip's label, and lowlit, because it is the answer to
// "is there a faster way to do this" rather than part of the label.
export function ShortcutHint({ keys, note, size = 'sm' }: { keys: string[]; note?: string; size?: KbdSize }) {
  return (
    <span className="inline-flex items-center justify-center gap-1 text-gray-500 dark:text-gray-400">
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`} size={size}>
          {k}
        </Kbd>
      ))}
      {note && <span className="text-3xs">{note}</span>}
    </span>
  )
}

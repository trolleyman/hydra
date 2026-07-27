// Resolving a lucide-react icon from a user-typed name. Used by the project
// icon (see projectIconValue.ts for how the whole icon string is interpreted)
// and by the icon picker in project settings.
//
// Two things this has to get right:
//
//   - Spelling. lucide.dev lists every icon in kebab-case ("folder-dot") while
//     the React export is PascalCase ("FolderDot"), and people copy whichever
//     one they were looking at. So names are matched on their *normalized*
//     form - lowercased with every non-alphanumeric character stripped
//     ("folderdot") - which makes both spellings (plus "folder_dot" and
//     "Folder Dot") the same name. All ~1750 lucide names stay distinct under
//     that normalization; lucideIcons.test.ts asserts it.
//
//   - Coverage. lucide ships ~1750 icons, and statically importing all of them
//     would drop several hundred KB of icon data into the main bundle. So a
//     curated set is bundled eagerly (EAGER_LUCIDE_ICONS below) and everything
//     else arrives in one lazily-fetched chunk (see lucideAllIcons.ts for why
//     that indirection is needed to get a chunk at all). It is fetched the first
//     time a project actually uses a non-curated icon, or when the icon picker
//     opens.

import { useEffect, useState } from 'react'
import {
  Folder, FolderDot, FolderGit2, FolderOpen, Rocket, Database, Server, Cloud, Cpu,
  Terminal, Code, CodeXml, Braces, Binary, Box, Boxes, Package, Container, Globe, Bug,
  Beaker, FlaskConical, Wrench, Hammer, Cog, Settings, Zap, Flame, Star, Heart,
  Sparkles, Bookmark, Flag, Bell, House, Building, Building2, Layers, LayoutGrid,
  Component, Palette, Brush, Camera, Image, Film, Music, Book, BookOpen, FileText,
  Newspaper, ShoppingCart, ShoppingBag, CreditCard, DollarSign, Briefcase, Users,
  User, Bot, Brain, Shield, ShieldCheck, Lock, Key, Gamepad2, Puzzle, Leaf, TreePine,
  Sprout, Sun, Moon, Coffee, Rss, Radio, Signal, Wifi, Smartphone, Tablet, Laptop,
  Monitor, HardDrive, Compass, Map, MapPin, Bird, Cat, Dog, Ghost, Anchor, Atom,
  Feather, Gem, Crown, Trophy, Target, WandSparkles, Music2, Headphones, MessageSquare,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react'

export type { LucideIcon }

// An icon name reduced to its comparable form: lowercase, separators removed.
// "FolderDot", "folder-dot", "folder_dot" and "Folder Dot" all become "folderdot".
export function normalizeIconName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// A lucide PascalCase export name in the kebab-case spelling lucide.dev shows,
// for display in the picker and as the value it writes into config. A handful of
// digit-heavy names differ slightly from lucide's own file name ("ArrowDown01"
// gives "arrow-down-01", lucide calls it "arrow-down-0-1"); they normalize to the
// same thing, so both resolve - only the label is cosmetic.
export function kebabIconName(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .toLowerCase()
}

// Icons bundled with the main chunk, keyed by normalized name: the ones the app
// itself ships defaults for (the built-in chat project's message-square), the
// settings presets, and a spread of names that read well as project markers.
// Anything outside this set still resolves - it just waits for the lazy chunk.
export const EAGER_LUCIDE_ICONS: Record<string, LucideIcon> = {
  folder: Folder, folderdot: FolderDot, foldergit2: FolderGit2, folderopen: FolderOpen,
  rocket: Rocket, database: Database, server: Server, cloud: Cloud, cpu: Cpu,
  terminal: Terminal, code: Code, codexml: CodeXml, braces: Braces, binary: Binary,
  box: Box, boxes: Boxes, package: Package, container: Container, globe: Globe,
  bug: Bug, beaker: Beaker, flaskconical: FlaskConical, wrench: Wrench,
  hammer: Hammer, cog: Cog, settings: Settings, zap: Zap, flame: Flame, star: Star,
  heart: Heart, sparkles: Sparkles, bookmark: Bookmark, flag: Flag, bell: Bell,
  house: House, building: Building, building2: Building2, layers: Layers,
  layoutgrid: LayoutGrid, component: Component, palette: Palette, brush: Brush,
  camera: Camera, image: Image, film: Film, music: Music, music2: Music2,
  book: Book, bookopen: BookOpen, filetext: FileText, newspaper: Newspaper,
  shoppingcart: ShoppingCart, shoppingbag: ShoppingBag, creditcard: CreditCard,
  dollarsign: DollarSign, briefcase: Briefcase, users: Users, user: User, bot: Bot,
  brain: Brain, shield: Shield, shieldcheck: ShieldCheck, lock: Lock, key: Key,
  gamepad2: Gamepad2, puzzle: Puzzle, leaf: Leaf, treepine: TreePine, sprout: Sprout,
  sun: Sun, moon: Moon, coffee: Coffee, rss: Rss, radio: Radio, signal: Signal,
  wifi: Wifi, smartphone: Smartphone, tablet: Tablet, laptop: Laptop,
  monitor: Monitor, harddrive: HardDrive, compass: Compass, map: Map, mappin: MapPin,
  bird: Bird, cat: Cat, dog: Dog, ghost: Ghost, anchor: Anchor, atom: Atom,
  feather: Feather, gem: Gem, crown: Crown, trophy: Trophy, target: Target,
  wandsparkles: WandSparkles, headphones: Headphones, messagesquare: MessageSquare,
  messagessquare: MessagesSquare,
}

// Everyday words that are not lucide names, mapped to the icon people mean by
// them - plus the handful of names this map itself used to accept before it was
// keyed by canonical names ("code2", "wand2"), so an icon already set in a
// config.toml keeps rendering. Only consulted after the real names, and no alias
// may shadow a real icon (lucideIcons.test.ts asserts that) - which is why
// "phone", "wand" and "gamepad" are deliberately absent: those are real lucide
// icons in their own right, and they win their own names.
export const LUCIDE_ALIASES: Record<string, string> = {
  fire: 'flame',
  code2: 'codexml',
  wand2: 'wandsparkles',
  gear: 'cog',
  robot: 'bot',
  chat: 'messagesquare',
  message: 'messagesquare',
  messages: 'messagessquare',
  document: 'filetext',
  flask: 'flaskconical',
  grid: 'layoutgrid',
  cart: 'shoppingcart',
  dollar: 'dollarsign',
  tree: 'treepine',
  mobile: 'smartphone',
  game: 'gamepad2',
  home: 'house',
}

export type LucideIconEntry = { name: string; icon: LucideIcon }

type LucideIconSet = {
  // Normalized name -> component, for resolving a typed value.
  byName: Record<string, LucideIcon>
  // Every icon, kebab-named and sorted, for the picker.
  list: LucideIconEntry[]
}

// Populated once the lazy chunk lands; until then only EAGER_LUCIDE_ICONS is
// available synchronously.
let loaded: LucideIconSet | null = null
let inFlight: Promise<LucideIconSet> | null = null

// loadLucideIcons fetches the full icon set (one lazy chunk, then cached).
export function loadLucideIcons(): Promise<LucideIconSet> {
  if (loaded) return Promise.resolve(loaded)
  if (!inFlight) {
    inFlight = import('./lucideAllIcons').then((mod) => {
      const byName: Record<string, LucideIcon> = {}
      const list: LucideIconEntry[] = []
      for (const [pascal, icon] of Object.entries(mod.icons)) {
        byName[normalizeIconName(pascal)] = icon
        list.push({ name: kebabIconName(pascal), icon })
      }
      list.sort((a, b) => a.name.localeCompare(b.name))
      loaded = { byName, list }
      return loaded
    })
  }
  return inFlight
}

// Whether the full set has arrived. Once it has, a name that still does not
// resolve is not an icon at all, and callers stop waiting on it.
export function lucideIconsLoaded(): boolean {
  return loaded !== null
}

// lucideIcon resolves a name against whatever is available right now: the eager
// set always, the full set once it has loaded. Aliases are consulted last so a
// real lucide icon always wins its own name.
export function lucideIcon(name: string): LucideIcon | undefined {
  const n = normalizeIconName(name)
  if (!n) return undefined
  const direct = EAGER_LUCIDE_ICONS[n] ?? loaded?.byName[n]
  if (direct) return direct
  const alias = LUCIDE_ALIASES[n]
  if (!alias) return undefined
  return EAGER_LUCIDE_ICONS[alias] ?? loaded?.byName[alias]
}

// Whether a value is worth resolving as an icon name at all - i.e. whether a
// miss should pull down the full set. Emoji and other non-ASCII glyphs never
// match, so they render immediately as themselves.
export function looksLikeIconName(value: string): boolean {
  return /^[a-z][a-z0-9]*([-_ ][a-z0-9]+)*$/i.test(value.trim())
}

// useLucideIcon resolves a name, fetching the full icon set if the name is a
// plausible icon name that the eager set does not cover. `pending` is true only
// while that fetch is outstanding - render a blank box rather than the raw text,
// which would otherwise flash the name before the icon replaces it. Once the set
// has loaded, an unresolved name is settled: it is not an icon, so pending goes
// false and the caller can fall back for good.
export function useLucideIcon(name: string): { icon: LucideIcon | undefined; pending: boolean } {
  const icon = lucideIcon(name)
  const wanted = !icon && !!name && looksLikeIconName(name)
  const [, bump] = useState(0)

  useEffect(() => {
    if (!wanted) return
    let live = true
    void loadLucideIcons().then(() => {
      // Re-render so lucideIcon() above sees the now-loaded set.
      if (live) bump((n) => n + 1)
    })
    return () => {
      live = false
    }
  }, [wanted, name])

  return { icon, pending: wanted && !lucideIconsLoaded() }
}

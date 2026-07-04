// Resolves a project's custom `icon` string (see internal/projects ProjectInfo)
// into something to render in place of the default folder glyph. The single
// string is interpreted by its content, matching the backend contract:
//   - a value ending in an image extension is an image (an http(s)/data URI is
//     used directly, any other path is served by the backend /project-icon route);
//   - a known lucide-react icon name (case-insensitive) renders that icon;
//   - anything else is rendered as text - i.e. an emoji, or a short label.
// Empty falls back to the folder icon.

import {
  Folder, FolderGit2, FolderOpen, Rocket, Database, Server, Cloud, Cpu, Terminal,
  Code, Code2, Braces, Binary, Box, Boxes, Package, Container, Globe, Bug, Beaker,
  FlaskConical, Wrench, Hammer, Cog, Settings, Zap, Flame, Star, Heart, Sparkles,
  Bookmark, Flag, Bell, Home, Building, Building2, Layers, LayoutGrid, Component,
  Palette, Brush, Camera, Image, Film, Music, Book, BookOpen, FileText, Newspaper,
  ShoppingCart, ShoppingBag, CreditCard, DollarSign, Briefcase, Users, User, Bot,
  Brain, Shield, ShieldCheck, Lock, Key, Gamepad2, Puzzle, Leaf, TreePine, Sprout,
  Sun, Moon, Coffee, Rss, Radio, Signal, Wifi, Smartphone, Tablet, Laptop, Monitor,
  HardDrive, Compass, Map, MapPin, Bird, Cat, Dog, Ghost,
  Anchor, Atom, Feather, Gem, Crown, Trophy, Target, Wand2, Music2, Headphones,
  type LucideIcon,
} from 'lucide-react'

// Curated set of lucide icons a project can name. Keyed by lowercased icon name
// so lookups are case-insensitive. lucide-react (this version) ships no dynamic
// name->component loader, and importing the whole set would bloat the bundle, so
// this is a hand-picked list of the icons most useful as project markers. An
// unknown name falls through to being rendered as text (see ProjectIcon).
const LUCIDE_ICONS: Record<string, LucideIcon> = {
  folder: Folder, foldergit2: FolderGit2, folderopen: FolderOpen,
  rocket: Rocket, database: Database, server: Server, cloud: Cloud, cpu: Cpu,
  terminal: Terminal, code: Code, code2: Code2, braces: Braces, binary: Binary,
  box: Box, boxes: Boxes, package: Package, container: Container, globe: Globe,
  bug: Bug, beaker: Beaker, flask: FlaskConical, flaskconical: FlaskConical,
  wrench: Wrench, hammer: Hammer, cog: Cog, settings: Settings, gear: Cog,
  zap: Zap, flame: Flame, fire: Flame, star: Star, heart: Heart, sparkles: Sparkles,
  bookmark: Bookmark, flag: Flag, bell: Bell, home: Home, house: Home,
  building: Building, building2: Building2, layers: Layers, grid: LayoutGrid,
  layoutgrid: LayoutGrid, component: Component, palette: Palette, brush: Brush,
  camera: Camera, image: Image, film: Film, music: Music, music2: Music2,
  book: Book, bookopen: BookOpen, filetext: FileText, document: FileText,
  newspaper: Newspaper, cart: ShoppingCart, shoppingcart: ShoppingCart,
  shoppingbag: ShoppingBag, creditcard: CreditCard, dollar: DollarSign,
  dollarsign: DollarSign, briefcase: Briefcase, users: Users, user: User,
  bot: Bot, robot: Bot, brain: Brain, shield: Shield, shieldcheck: ShieldCheck,
  lock: Lock, key: Key, game: Gamepad2, gamepad: Gamepad2, gamepad2: Gamepad2,
  puzzle: Puzzle, leaf: Leaf, tree: TreePine, treepine: TreePine, sprout: Sprout,
  sun: Sun, moon: Moon, coffee: Coffee, rss: Rss, radio: Radio, signal: Signal,
  wifi: Wifi, phone: Smartphone, smartphone: Smartphone, mobile: Smartphone,
  tablet: Tablet, laptop: Laptop, monitor: Monitor, harddrive: HardDrive,
  compass: Compass, map: Map, mappin: MapPin, bird: Bird, cat: Cat, dog: Dog,
  ghost: Ghost, anchor: Anchor, atom: Atom, feather: Feather, gem: Gem,
  crown: Crown, trophy: Trophy, target: Target, wand: Wand2, wand2: Wand2,
  headphones: Headphones,
}

// The set of extensions that mark an icon value as an image. Kept in sync with
// isImageIcon in internal/http/project_icon.go.
const IMAGE_ICON_RE = /\.(png|svg|ico|jpe?g|gif|webp|avif|bmp)$/i

const DIRECT_URI_RE = /^(https?:|data:)/i

export function ProjectIcon({
  icon,
  projectId,
  size = 14,
  className = '',
}: {
  icon: string | null | undefined
  // Needed to build the backend image URL for a bare-path image icon.
  projectId: string
  // Rendered box size in pixels (icons and emoji are sized to this).
  size?: number
  className?: string
}) {
  const v = (icon ?? '').trim()

  if (!v) return <Folder size={size} className={className} />

  if (IMAGE_ICON_RE.test(v)) {
    const src = DIRECT_URI_RE.test(v) ? v : `/project-icon/projects/${encodeURIComponent(projectId)}`
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain' }}
        className={`rounded-[3px] ${className}`}
      />
    )
  }

  const Lucide = LUCIDE_ICONS[v.toLowerCase()]
  if (Lucide) return <Lucide size={size} className={className} />

  // Emoji or short text label: render the glyph itself, sized to the box.
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center leading-none ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.95) }}
    >
      {v}
    </span>
  )
}

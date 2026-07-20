// How a project's custom `icon` string (see internal/projects ProjectInfo) is
// interpreted, shared by the two renderers of it:
//   - projectIcon.tsx    - renders it as JSX (the in-app project glyph);
//   - projectIconUrl.ts  - rasterizes it to a URL (OS notification / favicon).
//
// The interpretation matches the backend contract:
//   - a value ending in an image extension is an image (an http(s)/data URI is
//     used directly, any other path is served by the backend /project-icon route);
//   - a known lucide-react icon name (case-insensitive) is that icon;
//   - anything else is a glyph - i.e. an emoji, or a short label.
//
// This lives apart from projectIcon.tsx purely because react-refresh requires a
// component file to export only components.

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
export const LUCIDE_ICONS: Record<string, LucideIcon> = {
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
export const IMAGE_ICON_RE = /\.(png|svg|ico|jpe?g|gif|webp|avif|bmp)$/i

const DIRECT_URI_RE = /^(https?:|data:)/i

// Where to fetch an image icon from: an http(s)/data URI is used verbatim, any
// other value is a path the backend serves out of the project.
export function projectImageIconSrc(icon: string, projectId: string): string {
  return DIRECT_URI_RE.test(icon) ? icon : `/project-icon/projects/${encodeURIComponent(projectId)}`
}

// Deterministic hue (0-359) hashed from the project id, for the default icon's
// background. Plain 31-multiplier string hash.
export function hashHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ((h % 360) + 360) % 360
}

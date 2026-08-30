// File tree helpers for the diff viewer's sidebar: turn a flat list of changed
// files into a nested tree (buildFileTree), fold single-child directory chains
// the way VS Code's "compact folders" does (compactTree), or group files by their
// immediate folder (getGroupedFiles). Kept in a non-component module so the diff
// viewer and the repository browser can share them without tripping fast refresh.
import type { DiffFile } from '../api'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children: TreeNode[]
  file?: DiffFile
}

export function buildFileTree(files: DiffFile[]): TreeNode[] {
  const root: TreeNode[] = []
  const directories = new WeakMap<TreeNode[], Map<string, TreeNode>>()
  for (const file of files) {
    const parts = file.path.split('/')
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      let byName = directories.get(current)
      if (!byName) {
        byName = new Map()
        directories.set(current, byName)
      }
      let node = byName.get(parts[i])
      if (!node) {
        node = { name: parts[i], path: parts.slice(0, i + 1).join('/'), type: 'dir', children: [] }
        current.push(node)
        byName.set(node.name, node)
      }
      current = node.children
    }
    current.push({ name: parts[parts.length - 1], path: file.path, type: 'file', children: [], file })
  }
  return root
}

// compactTree merges chains of single-child directories into one node, the way
// VS Code's "compact folders" does: one/two/three renders on a single row when
// `one` contains only `two` and `two` contains only `three`. This trims the
// horizontal indent that deeply nested trees would otherwise waste.
//
// A directory is folded into its child only when that child is its *sole* entry
// and is itself a directory - so a folder holding a file (or more than one
// child) stops the chain. The merged node keeps the deepest folder's `path`
// (stable, unique → safe as a collapse-state / React key) and joins the segment
// names for display.
export function compactTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.type !== 'dir') return node
    let current = node
    const names = [node.name]
    while (current.children.length === 1 && current.children[0].type === 'dir') {
      current = current.children[0]
      names.push(current.name)
    }
    return { ...current, name: names.join('/'), children: compactTree(current.children) }
  })
}

export function getGroupedFiles(files: DiffFile[]): [string, DiffFile[]][] {
  const map = new Map<string, DiffFile[]>()
  for (const file of files) {
    const parts = file.path.split('/')
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    if (!map.has(folder)) map.set(folder, [])
    map.get(folder)!.push(file)
  }
  return Array.from(map.entries())
}

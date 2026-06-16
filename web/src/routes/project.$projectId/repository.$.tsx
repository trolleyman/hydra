import { createFileRoute } from '@tanstack/react-router'

// Splat route for deep repository URLs (/project/X/repository/<ref>/<path...>).
// It renders nothing — the parent repository route reads the path from the URL
// and renders the browser — but it must exist so these URLs are valid routes
// (and are served on a hard refresh; see web/scripts/generate-routes-regex.ts).
export const Route = createFileRoute('/project/$projectId/repository/$')({
  component: () => null,
})

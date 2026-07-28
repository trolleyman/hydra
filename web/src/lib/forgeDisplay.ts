// providerLabel names the forge for user-facing copy ("Open on GitHub", "Reply
// on GitLab"), so no UI string has to fall back to the vague "the forge" when
// the provider is actually known. Lives in lib/ rather than beside ProviderIcon
// because a component module may only export components (react-refresh).
export function providerLabel(provider?: string): string {
  if (provider === 'github') return 'GitHub'
  if (provider === 'gitlab') return 'GitLab'
  return 'the forge'
}

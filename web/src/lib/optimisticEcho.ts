export function optimisticEchoIndex(
  pending: readonly { clientId: string; text: string }[],
  clientId: string,
  text: string,
): number {
  const exact = clientId === '' ? -1 : pending.findIndex((item) => item.clientId === clientId)
  return exact >= 0 ? exact : pending.findIndex((item) => item.text === text)
}

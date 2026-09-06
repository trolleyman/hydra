import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the extension protocol is composed from the shared policy and chat schemas', async () => {
  const [host, chat, generated] = await Promise.all([
    readFile('../api/agent-host.yaml', 'utf8'),
    readFile('../api/chat.yaml', 'utf8'),
    readFile('src/generated/protocol.ts', 'utf8'),
  ])
  assert.match(host, /\.\/policy\.yaml#\/components\/schemas\/EffectivePolicy/)
  for (const schema of ['ChatProjection', 'ChatEvent']) {
    assert.match(host, new RegExp(`\\.\\/chat\\.yaml#\\/components\\/schemas\\/${schema}`))
  }
  for (const schema of ['ChatEvent', 'ChatEventUnion', 'ChatProjection', 'ChatFrame']) {
    assert.match(chat, new RegExp(`openapi\\.yaml#\\/components\\/schemas\\/${schema}`))
  }
  for (const generatedType of ['HostCommand:', 'HostFrame:', 'EffectivePolicy:', 'ChatProjection:', 'ChatEvent:']) {
    assert.ok(generated.includes(generatedType), `${generatedType} is present in the generated TypeScript contract`)
  }
})

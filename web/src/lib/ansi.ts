// stripAnsi removes ANSI escape sequences (colour/style codes like ESC[2m,
// ESC[22m, cursor moves, etc.) from a string so raw terminal output renders as
// plain text in the UI. The pattern is the well-known ansi-regex one, built
// from a string so the ESC () / CSI () bytes are unambiguous; we
// inline it rather than pull in a dependency for a single one-liner.
//
// TODO(PLAN #46): render these sequences as actual colours/styles instead of
// stripping them — see PLAN.md "Render ANSI in artifact logs/errors".
const ANSI_PATTERN =
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*' +
  '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))'

export function stripAnsi(input: string): string {
  return input.replace(new RegExp(ANSI_PATTERN, 'g'), '')
}

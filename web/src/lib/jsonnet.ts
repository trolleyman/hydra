import type { Syntax } from 'refractor/core'

// Jsonnet is not shipped by Prism/refractor. This small grammar covers its
// distinctive comments, strings, object fields, keywords and operators while
// retaining Prism's normal token classes and theme.
const jsonnet: Syntax = function jsonnet(Prism) {
  Prism.languages.jsonnet = {
    comment: [
      { pattern: /\/\*[\s\S]*?(?:\*\/|$)/, greedy: true },
      { pattern: /(^|[^:])\/\/.*/, lookbehind: true, greedy: true },
    ],
    string: [
      { pattern: /\|\|\|[\s\S]*?\|\|\|/, greedy: true },
      { pattern: /@"(?:""|[^"])*"/, greedy: true },
      { pattern: /"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/, greedy: true },
    ],
    property: {
      pattern: /\b[A-Za-z_$][\w$-]*(?=\s*\+?:{1,3})/,
    },
    keyword: /\b(?:assert|else|error|false|for|function|if|import|importbin|importstr|in|local|null|self|super|tailstrict|then|true)\b/,
    function: /\b[A-Za-z_$][\w$]*(?=\s*\()/,
    number: /\b(?:0[xX][\dA-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\b/,
    operator: /\+:{1,3}|:{1,3}|&&|\|\||[!=]==?|<=?|>=?|[-+*/%~^]/,
    punctuation: /[{}[\](),.;]/,
  }
}

jsonnet.displayName = 'jsonnet'
jsonnet.aliases = []

export default jsonnet

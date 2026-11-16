# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/nycthyraxo-oss/markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/nycthyraxo-oss/markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A dependency-free JavaScript module that renders Markdown to exactly the HTML
[marked](https://github.com/markedjs/marked) 18.1.3 produces with its default
options (GFM on) — and faster than marked itself. Built for the
[make.fun](https://make.fun) competition
[Make Markdown rendering faster](https://make.fun/c/markdown-render-speed-02).

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome *emphasis* and a [link](https://example.com).');
// '<h1>Hello</h1>\n<p>Some <em>emphasis</em> and a <a href="https://example.com">link</a>.</p>\n'
```

`parse(markdown)` returns, for every string, exactly the HTML that
`marked.parse(markdown)` returns with marked's default options (GFM on,
breaks off, pedantic off, async off). It covers the full CommonMark 0.31.2
spec, the GFM 0.29 extensions (tables, strikethrough, extended autolinks,
task lists), and long generated README documents — 720/720 practice cases
byte-for-byte identical to marked.

## Entry point

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, renders each one with `parse`, and writes
`/output/html.json`.

## How it stays fast

The parser mirrors marked's tokenizer, lexer and renderer, with three
cheap shortcuts that never change output:

- Plain-text inline runs (no backslash, backtick, emphasis, link, tag,
  autolink or entity trigger) lex as a single text token.
- List continuation lines skip the six break tests when their first
  non-space character cannot start any of them.
- List lines skip tab expansion when they have no leading whitespace.

On the 720-case practice set it runs about 1.1x faster than marked
(3 warmups + 5 timed runs, same machine).

## License

MIT. See [LICENSE](LICENSE).

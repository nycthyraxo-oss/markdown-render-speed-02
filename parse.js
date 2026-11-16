// parse.js — a fast, dependency-free Markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off, async off).
// Written fresh in this session: a single-pass block lexer plus an inline
// lexer, with the same token rules marked uses, structured for speed
// (prebuilt regexes, no per-call options merging, no extension hooks).

// ---- tiny regex composer -------------------------------------------------
// Builds a RegExp from a template (string or regex source) by textual
// replacement, the same way marked composes its rules. A replacement whose
// source starts with ^ loses the caret (it would be wrong mid-pattern).
const CARET = /(^|[^\[])\^/g;
function rx(template, flags) {
  let src = typeof template === 'string' ? template : template.source;
  const api = {
    replace(search, repl) {
      let ins = typeof repl === 'string' ? repl : repl.source;
      ins = ins.replace(CARET, '$1');
      src = src.replace(search, ins);
      return api;
    },
    getRegex() { return new RegExp(src, flags); },
  };
  return api;
}
// Cache a regex factory by indent (indent-1 clamped to slots 0..3, and the
// builder receives the slot number, not the original indent — marked's D()).
function indentCached(build) {
  const cache = [];
  return (n) => {
    const slot = Math.max(0, Math.min(3, n - 1));
    return cache[slot] || (cache[slot] = build(slot));
  };
}

// ---- character classes used by the emphasis rules -----------------------
const PUNCT = /[\p{P}\p{S}]/u;            // any punctuation / symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;    // whitespace or punctuation
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u; // neither space nor punctuation
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const SPACE_PUNCT_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

// ---- small shared patterns ------------------------------------------------
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const INDENT_CODE_COMPENSATION = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const STARTING_SPACE_CHAR = /^ /;
const ENDING_SPACE_CHAR = / $/;
const ENDING_SPACE_TAB_CHAR = /[ \t]$/;
const NON_SPACE_CHAR = /[^ ]/;
const NEWLINE_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEADING_SPACE_TAB = /^[ \t]+/;
const MULTI_SPACE_GLOBAL = /\s+/g;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK_LINE = /\n[ \t]*\n[ \t]*$/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_SETEXT_REPLACE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT_REPLACE2 = /^ {0,3}>[ \t]?/gm;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_REPLACE_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIMITER = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK_LINE = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_SCRIPT_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_SCRIPT_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE_BRACKET = /^</;
const END_ANGLE_BRACKET = />$/;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const NUMERIC_CHAR_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_CHAR_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PERCENT_DECODE = /%25/g;
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
const CARRIAGE_RETURN = /\r\n|\r/g;
const SPACE_LINE = /^ +$/gm;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;

// Indent-dependent block-start checks (cached per indent like marked's D()).
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
const nextBulletRegex = indentCached((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`));
const hrRegex = indentCached((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = indentCached((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRegex = indentCached((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = indentCached((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = indentCached((n) => new RegExp(`^ {0,${n}}>`));

// ---- block regexes (GFM) ---------------------------------------------------
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT_RE = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_TEXT = /^[^\n]+/;
const BULLET_RE = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const LABEL_INNER = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

// Paragraph builder: the paragraph rule with the listed block starters
// excluded from its continuation lines.
function paragraphRule(listRe, tableRe) {
  const para = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
  const built = rx(para)
    .replace('hr', BLOCK_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '');
  if (tableRe) built.replace('table', tableRe);
  else built.replace('|table', '');
  return built
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listRe)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS)
    .getRegex();
}

const BLOCK_DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL_INNER)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const BLOCK_LIST = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BULLET_RE)
  .getRegex();

const BLOCK_HTML = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .replace('comment', COMMENT_RE)
  .replace('tag', BLOCK_TAGS)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const BLOCK_LHEADING = rx(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .replace(/bull/g, BULLET_RE)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const BLOCK_TABLE = rx('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAGS)
  .getRegex();

// Paragraph rules (after BLOCK_TABLE: GFM paragraph embeds the table pattern;
// the blockquote paragraph removes |table like marked's Ke).
const BLOCK_PARA_BLOCKQUOTE = paragraphRule(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const BLOCK_PARA = paragraphRule(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, BLOCK_TABLE);

const BLOCK_BLOCKQUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', BLOCK_PARA_BLOCKQUOTE).getRegex();

// ---- inline regexes (GFM) ---------------------------------------------------
const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
// Matches when src contains ANY inline trigger (backslash, backtick, */_/~,
// '[', '<', '@', '![', '://', 'www.', or a hard break '  \n').
const INLINE_PLAIN = /[\\`*_~\[<@&]|!\[|:\/\/|www\.| {2}\n/;
const INLINE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER_TEMPLATE = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', LABEL_BRACKETS)
  .getRegex();
const LABEL_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LABEL_REF_FULL = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', LABEL_BRACKETS)
  .getRegex();
const INLINE_TAG = rx('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', rx(COMMENT_RE).replace('(?:-->|$)', '-->').getRegex())
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();
const INLINE_LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LABEL_INNER_TEMPLATE)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const INLINE_REFLINK = rx(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LABEL_INNER_TEMPLATE)
  .replace('ref', LABEL_INNER)
  .getRegex();
const INLINE_NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL_INNER).getRegex();
const INLINE_REFLINK_SEARCH = rx('reflink|nolink(?!\\()', 'g')
  .replace('reflink', rx(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL_REF_FULL).replace('ref', LABEL_REF).getRegex())
  .replace('nolink', rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL_REF).getRegex())
  .getRegex();
const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const INLINE_AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', EMAIL_RE)
  .getRegex();
const INLINE_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const INLINE_EMAIL_GROUPED = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const INLINE_EMAIL_PROTOCOL = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, INLINE_EMAIL).getRegex();
const INLINE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const INLINE_URL = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', INLINE_EMAIL_PROTOCOL)
  .replace('protocol', INLINE_PROTOCOL)
  .replace('email', INLINE_EMAIL_GROUPED)
  .getRegex();
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Emphasis delimiter rules (left-flanking / right-flanking patterns).
const EM_LDELIM = rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .replace(/punct/g, PUNCT_NOT_TILDE)
  .getRegex();
const EM_RDELIM_AST = rx('^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .replace(/punctSpace/g, SPACE_PUNCT_NOT_TILDE)
  .replace(/punct/g, PUNCT_NOT_TILDE)
  .getRegex();
const EM_RDELIM_UND = rx('^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const DEL_LDELIM = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).getRegex();
const DEL_RDELIM = rx('^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const PUNCTUATION_RE = rx(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).getRegex();
const ANY_PUNCT = rx(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const ANY_PUNCT_OUTSIDE_CODE = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const BLOCK_SKIP = rx(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();
// GFM inline text: consume up to the next inline opener.
const INLINE_TEXT = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', INLINE_PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

// ---- helpers ---------------------------------------------------------------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s, encode) {
  if (encode) return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_REPLACE, (c) => ESCAPE_MAP[c]) : s;
  return ESCAPE_TEST_NO_ENCODE.test(s) ? s.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => ESCAPE_MAP[c]) : s;
}
function unescapeHtml(a) {
  return NUMERIC_CHAR_REF.test(a)
    ? a.replace(NUMERIC_CHAR_REF_OR_AMP, (m, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      return code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)
        ? '�'
        : code === 38 ? '&amp;' : String.fromCodePoint(code);
    })
    : a;
}
function encodeHref(a) {
  try { return encodeURI(a).replace(PERCENT_DECODE, '%'); } catch { return null; }
}
// Split a table row on unescaped pipes; trim cells; pad/truncate to n.
function splitTableRow(a, n) {
  const t = a.replace(FIND_PIPE, (r, o, i) => {
    let flip = false, p = o;
    for (; --p >= 0 && i[p] === '\\';) flip = !flip;
    return flip ? '|' : ' |';
  });
  const cells = t.split(SPLIT_PIPE);
  let s = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (n) {
    if (cells.length > n) cells.splice(n);
    else for (; cells.length < n;) cells.push('');
  }
  for (; s < cells.length; s++) cells[s] = cells[s].trim().replace(SLASH_PIPE, '|');
  return cells;
}
// Trim trailing chars: ch when not===undefined... (marked's L): strip trailing
// ch (not=false) or trailing chars that are NOT ch (not=true).
function trimEndChars(a, ch, not) {
  const n = a.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n;) {
    const r = a.charAt(n - s - 1);
    if (r === ch && !not) s++;
    else if (r !== ch && not) s++;
    else break;
  }
  return a.slice(0, n - s);
}
// Trim trailing blank lines, keeping at most one trailing newline.
function trimBlankEnd(a) {
  const e = a.split('\n'), t = e.length - 1;
  let i = t;
  for (; i >= 0 && BLANK_LINE.test(e[i]);) i--;
  return e.length - i <= 2 ? a : e.slice(0, i + 1).join('\n');
}
// Normalize a link label: trim, collapse whitespace, case-fold.
function normLabel(a) {
  return a.trim().replace(MULTI_SPACE_GLOBAL, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Find the index of the paren that closes the one opened at depth 1:
// returns the index, -2 if unclosed, -1 if no parens at all.
function findMatchingParen(a, pair) {
  if (a.indexOf(pair[0]) === -1 && a.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') n++;
    else if (a[n] === pair[0]) depth++;
    else if (a[n] === pair[1] && (depth--, depth < 0)) return n;
  }
  return depth > 0 ? -2 : -1;
}
// Expand tabs to the next multiple of 4, starting at column col.
function expandTabs(a, col = 0) {
  let t = col, out = '';
  for (const s of a) {
    if (s === '\t') { const r = 4 - t % 4; out += ' '.repeat(r); t += r; }
    else { out += s; t++; }
  }
  return out;
}
// Fence indent compensation: strip the fence line's leading whitespace from
// each content line, up to that many columns.
function fenceIndentCompensation(a, e) {
  const n = a.match(INDENT_CODE_COMPENSATION);
  if (n === null) return e;
  const s = n[1];
  return e.split('\n').map((r) => {
    const o = r.match(BEGINNING_SPACE);
    if (o === null) return r;
    const [i] = o;
    return r.slice(Math.min(i.length, s.length));
  }).join('\n');
}
// Guard used by link/reflink: does the label text contain a link/autolink
// that reaches past the end of the label?
function linkInText(src, label, labelOffset, tokenizer) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const i = INLINE_CODE.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(labelOffset + s);
    const o = INLINE_TAG.exec(r) || INLINE_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
// Build a link/image token: lex the label text inline, tracking whether a
// nested link was emitted (nested links are rejected for links).
function buildLinkToken(cap, link, raw, lexer) {
  const href = link.href, title = link.title || null;
  const text = cap[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedLinkEmitted = lexer.state.linkEmitted;
  const savedInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const emitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedLinkEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) { lexer.state.inRawBlock = savedInRawBlock; return undefined; }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}
// ---- emphasis mask machinery ----------------------------------------------
// Scan a masked source for delimiter runs that could close emphasis:
// a run counts as a possible closer when the char before it is not space,
// tab, newline or form-feed. Only the last such run start is kept.
function scanDelims(a) {
  const e = { '*': -1, _: -1 };
  let t = -1;
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    for (; i < n && a[i] === r;) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') t = s;
      else e[r] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: a, lastEm: e, lastDel: t };
}
const maskCache = new WeakMap();
function pushMask(tokenizer, masked) {
  const arr = maskCache.get(tokenizer);
  if (arr) arr.push(scanDelims(masked));
  else maskCache.set(tokenizer, [scanDelims(masked)]);
}
function popMask(tokenizer) {
  const arr = maskCache.get(tokenizer);
  if (arr) {
    arr.pop();
    if (!arr.length) maskCache.delete(tokenizer);
  }
}
function lastEmCloser(tokenizer, maskedSrc, delim) {
  const arr = maskCache.get(tokenizer);
  const top = arr && arr[arr.length - 1];
  return top && top.maskedSrc === maskedSrc ? top.lastEm[delim] : scanDelims(maskedSrc).lastEm[delim];
}
function lastDelCloser(tokenizer, maskedSrc) {
  const arr = maskCache.get(tokenizer);
  const top = arr && arr[arr.length - 1];
  return top && top.maskedSrc === maskedSrc ? top.lastDel : scanDelims(maskedSrc).lastDel;
}
// Mask a source for emphasis scanning: hide link labels, code spans and
// inline links so their delimiters cannot open/close emphasis.
function maskSrc(lexer, src) {
  let t = src;
  if (lexer.tokens.links && src.includes('[')) {
    const s = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(lexer.tokens.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (lexer.linkInText(i)) return '[' + i.replace(INLINE_REFLINK_SEARCH, s) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(INLINE_REFLINK_SEARCH, s);
  }
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(BLOCK_SKIP, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

// ---- tokenizer -------------------------------------------------------------
class Tokenizer {
  constructor() { this.lexer = null; }

  // -- block tokenizers --
  space(src) {
    const t = BLOCK_NEWLINE.exec(src);
    if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
  }
  code(src) {
    const t = BLOCK_CODE.exec(src);
    if (t) {
      const n = trimBlankEnd(t[0]);
      const s = n.replace(CODE_REMOVE_INDENT, '');
      return { type: 'code', raw: n, codeBlockStyle: 'indented', text: s };
    }
  }
  fences(src) {
    const t = BLOCK_FENCES.exec(src);
    if (t) {
      const n = t[0];
      const s = fenceIndentCompensation(n, t[3] || '');
      return { type: 'code', raw: n, lang: t[2] ? t[2].trim().replace(ANY_PUNCT, '$1') : t[2], text: s };
    }
  }
  heading(src) {
    const t = BLOCK_HEADING.exec(src);
    if (t) {
      let n = t[2].trim();
      if (ENDING_HASH.test(n)) {
        const s = trimEndChars(n, '#');
        if (!s || ENDING_SPACE_TAB_CHAR.test(s)) n = s.trim();
      }
      return { type: 'heading', raw: trimEndChars(t[0], '\n'), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(src) {
    const t = BLOCK_HR.exec(src);
    if (t) return { type: 'hr', raw: trimEndChars(t[0], '\n') };
  }
  blockquote(src) {
    const t = BLOCK_BLOCKQUOTE.exec(src);
    if (t) {
      const lines = trimEndChars(t[0], '\n').split('\n');
      let raw = '', text = '';
      const tokens = [];
      for (; lines.length > 0;) {
        let found = false;
        const group = [];
        let p;
        for (p = 0; p < lines.length; p++) {
          if (BLOCKQUOTE_START.test(lines[p])) { group.push(lines[p]); found = true; }
          else if (!found) group.push(lines[p]);
          else break;
        }
        lines.splice(0, p);
        const h = group.join('\n');
        const u = h.replace(BLOCKQUOTE_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
          .replace(BLOCKQUOTE_SETEXT_REPLACE, '\n    $1')
          .replace(BLOCKQUOTE_SETEXT_REPLACE2, '');
        raw = raw ? `${raw}\n${h}` : h;
        text = text ? `${text}\n${u}` : u;
        const savedTop = this.lexer.state.top;
        this.lexer.state.top = true;
        this.lexer.blockTokens(u, tokens, true);
        this.lexer.state.top = savedTop;
        if (lines.length === 0) break;
        const k = tokens.at(-1);
        if (k?.type === 'code' || k?.type === 'heading' || k?.type === 'hr' || k?.type === 'html' || k?.type === 'table') break;
        if (k?.type === 'blockquote') {
          const g = k;
          const b = lines.join('\n');
          const m = g.raw + '\n' + b.replace(BLOCKQUOTE_SETEXT_REPLACE2, '');
          const f = this.blockquote(m);
          tokens[tokens.length - 1] = f;
          const y = m.substring(f.raw.length).replace(/^\n/, '');
          const R = y ? y.split('\n').length : 0;
          const A = R ? lines.slice(0, -R) : lines;
          if (A.length > 0 && (raw = `${raw}\n${A.join('\n')}`), text = text.substring(0, text.length - g.text.length) + f.text, lines.splice(0, A.length), lines.length > 0 && BLOCKQUOTE_START.test(lines[0])) continue;
          break;
        } else if (k?.type === 'list') {
          const g = k;
          const b = g.raw + '\n' + lines.join('\n');
          const m = this.list(b);
          tokens[tokens.length - 1] = m;
          const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
          if (f > 0) {
            const y = lines.slice(0, f).join('\n');
            raw = `${raw}\n${y}`;
            text = `${text}\n${y}`;
          }
          lines.splice(0, f);
          continue;
        }
      }
      return { type: 'blockquote', raw, tokens, text };
    }
  }
  list(src) {
    const cap = BLOCK_LIST.exec(src);
    if (!cap) return undefined;
    const full = src;
    const consumed = () => full.length - src.length;
    const bull = cap[1].trim();
    const ordered = bull.length > 1;
    const listTok = { type: 'list', raw: '', ordered, start: ordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
    const bullRe = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRe = listItemRegex(bullRe);
    let isLoose = false;
    while (src) {
      let itemWithBlank = false;
      let itemContent = '';
      const m = itemRe.exec(src);
      if (!m || BLOCK_HR.test(src)) break;
      const itemStart = consumed();
      src = src.substring(m[0].length);
      const firstLine = m[2].split('\n', 1)[0];
      const markerLen = m[1].length;
      let content = firstLine.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, markerLen));
      let nextLine = src.split('\n', 1)[0];
      let contentEmpty = !content.trim();
      let indent = 0;
      if (contentEmpty) indent = markerLen + 1;
      else {
        indent = content.search(NON_SPACE_CHAR);
        indent = indent > 4 ? 1 : indent;
        itemContent = content.slice(indent);
        indent += markerLen;
      }
      if (contentEmpty && BLANK_LINE.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        itemWithBlank = true;
      }
      if (!itemWithBlank) {
        const nextBullet = nextBulletRegex(indent);
        const hrRe = hrRegex(indent);
        const fencesRe = fencesBeginRegex(indent);
        const headingRe = headingBeginRegex(indent);
        const htmlRe = htmlBeginRegex(indent);
        const bqRe = blockquoteBeginRegex(indent);
        while (src) {
          const line = src.split('\n', 1)[0];
          let expanded;
          nextLine = line;
          expanded = (line[0] === ' ' || line[0] === '\t') ? nextLine.replace(LEADING_SPACE_TAB, (me) => expandTabs(me)) : nextLine;
          // The six break tests all need their pattern char first (after <=indent
          // spaces); skip them when the line's first non-space char cannot start any.
          const nsp = expanded.search(NON_SPACE_CHAR);
          const fc = nsp < 0 ? '' : expanded[nsp];
          const mayBreak = fc === '`' || fc === '~' || fc === '#' || fc === '<' || fc === '>' || fc === '*' || fc === '+' || fc === '-' || fc === '_' || (fc >= '0' && fc <= '9');
          if (mayBreak && (fencesRe.test(nextLine) || headingRe.test(nextLine) || htmlRe.test(nextLine) || bqRe.test(nextLine) || nextBullet.test(nextLine) || hrRe.test(nextLine))) break;
          if (nsp >= indent || nsp < 0) itemContent += '\n' + expanded.slice(indent);
          else {
            if (contentEmpty || content.replace(TAB_GLOBAL, '    ').search(NON_SPACE_CHAR) >= 4 || fencesRe.test(content) || headingRe.test(content) || htmlRe.test(content) || hrRe.test(content)) break;
            const qe = /^ {0,3}(?:=+|-+) *$/.test(nextLine) && BLOCK_LHEADING.test(`${content}\n${nextLine}`)
              ? `    ${expanded.replace(/^ {0,3}/, '')}` : nextLine;
            itemContent += '\n' + qe;
          }
          contentEmpty = nsp < 0;
          content = expanded.slice(indent);
          src = src.substring(line.length + 1);
        }
      }
      const itemRaw = full.slice(itemStart, consumed());
      if (!listTok.loose) {
        if (isLoose) listTok.loose = true;
        else if (DOUBLE_BLANK_LINE.test(itemRaw)) isLoose = true;
      }
      listTok.items.push({ type: 'list_item', raw: itemRaw, task: LIST_IS_TASK.test(itemContent), loose: false, text: itemContent, tokens: [] });
    }
    const last = listTok.items.at(-1);
    if (last) { last.raw = last.raw.trimEnd(); last.text = last.text.trimEnd(); }
    else return undefined;
    listTok.raw = full.slice(0, consumed()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((g) => g.type === 'space');
        const k = spaces.length > 0 && spaces.some((g) => ANY_LINE.test(g.raw));
        listTok.loose = k;
      }
    }
    for (const item of listTok.items) {
      const d = item.tokens[0];
      if (item.task && (d?.type === 'text' || d?.type === 'paragraph')) {
        item.text = item.text.replace(LIST_REPLACE_TASK, '');
        d.raw = d.raw.replace(LIST_REPLACE_TASK, '');
        d.text = d.text.replace(LIST_REPLACE_TASK, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (LIST_IS_TASK.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(LIST_REPLACE_TASK, '');
            break;
          }
        }
        const k = LIST_TASK_CHECKBOX.exec(item.raw);
        if (k) {
          const g = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
          item.checked = g.checked;
          if (listTok.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = g.raw + item.tokens[0].raw;
              item.tokens[0].text = g.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(g);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
            }
          } else {
            item.tokens.unshift(g);
          }
        }
      } else if (item.task) item.task = false;
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const d of item.tokens) if (d.type === 'text') d.type = 'paragraph';
      }
    }
    return listTok;
  }
  html(src) {
    const t = BLOCK_HTML.exec(src);
    if (t) {
      const n = trimBlankEnd(t[0]);
      return { type: 'html', block: true, raw: n, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: n };
    }
  }
  def(src) {
    const t = BLOCK_DEF.exec(src);
    if (t) {
      if (!START_ANGLE_BRACKET.test(t[2]) && findMatchingParen(t[2], '()') !== -1) return undefined;
      const n = normLabel(t[1]);
      const s = t[2] ? t[2].replace(HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '';
      const r = t[3] ? t[3].substring(1, t[3].length - 1).replace(ANY_PUNCT, '$1') : t[3];
      return { type: 'def', tag: n, raw: trimEndChars(t[0], '\n'), href: s, title: r };
    }
  }
  table(src) {
    const t = BLOCK_TABLE.exec(src);
    if (!t || !TABLE_DELIMITER.test(t[2])) return undefined;
    const headerCells = splitTableRow(t[1]);
    const aligns = t[2].replace(TABLE_ALIGN_CHARS, '').split('|');
    const rowLines = t[3]?.trim() ? t[3].replace(TABLE_ROW_BLANK_LINE, '').split('\n') : [];
    const out = { type: 'table', raw: trimEndChars(t[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length === aligns.length) {
      for (const i of aligns) {
        if (TABLE_ALIGN_RIGHT.test(i)) out.align.push('right');
        else if (TABLE_ALIGN_CENTER.test(i)) out.align.push('center');
        else if (TABLE_ALIGN_LEFT.test(i)) out.align.push('left');
        else out.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        out.header.push({ text: headerCells[i], tokens: this.lexer.inline(headerCells[i]), header: true, align: out.align[i] });
      }
      for (const row of rowLines) {
        out.rows.push(splitTableRow(row, out.header.length).map((cell, p) => ({ text: cell, tokens: this.lexer.inline(cell), header: false, align: out.align[p] })));
      }
      return out;
    }
    return undefined;
  }
  lheading(src) {
    const t = BLOCK_LHEADING.exec(src);
    if (t) {
      const n = t[1].trim();
      return { type: 'heading', raw: trimEndChars(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(src) {
    const t = BLOCK_PARA.exec(src);
    if (t) {
      const n = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
      return { type: 'paragraph', raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(src) {
    const t = BLOCK_TEXT.exec(src);
    if (t) return { type: 'text', raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }

  // -- inline tokenizers --
  escape(src) {
    const t = INLINE_ESCAPE.exec(src);
    if (t) return { type: 'escape', raw: t[0], text: t[1] };
  }
  tag(src) {
    const t = INLINE_TAG.exec(src);
    if (t) {
      if (!this.lexer.state.inLink && START_A_TAG.test(t[0])) this.lexer.state.inLink = true;
      else if (this.lexer.state.inLink && END_A_TAG.test(t[0])) this.lexer.state.inLink = false;
      if (!this.lexer.state.inRawBlock && START_PRE_SCRIPT_TAG.test(t[0])) this.lexer.state.inRawBlock = true;
      else if (this.lexer.state.inRawBlock && END_PRE_SCRIPT_TAG.test(t[0])) this.lexer.state.inRawBlock = false;
      return { type: 'html', raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
    }
  }
  link(src) {
    if (this.lexer.state.linkParenPossible === false) return undefined;
    const t = INLINE_LINK.exec(src);
    if (t) {
      const labelOffset = t[0].charAt(0) === '!' ? 2 : 1;
      if (linkInText(src, t[1], labelOffset, this)) return undefined;
      let href = t[2].trim();
      if (START_ANGLE_BRACKET.test(href)) {
        if (!END_ANGLE_BRACKET.test(href)) return undefined;
        const l = trimEndChars(href.slice(0, -1), '\\');
        if ((href.length - l.length) % 2 === 0) return undefined;
      } else {
        const l = findMatchingParen(t[2], '()');
        if (l === -2) return undefined;
        if (l > -1) {
          const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
          t[2] = t[2].substring(0, l);
          t[0] = t[0].substring(0, h).trim();
          t[3] = '';
        }
      }
      const r = trimEndChars(t[0].slice(0, -1), '\\');
      if ((t[0].length - r.length) % 2 === 0) return undefined;
      let o = t[2];
      let title = t[3] ? t[3].slice(1, -1) : '';
      o = o.trim();
      if (START_ANGLE_BRACKET.test(o)) o = o.slice(1, -1);
      return buildLinkToken(t, { href: o && o.replace(ANY_PUNCT, '$1'), title: title && title.replace(ANY_PUNCT, '$1') }, t[0], this.lexer);
    }
  }
  reflink(src, links) {
    let n;
    if ((n = INLINE_REFLINK.exec(src)) || (n = INLINE_NOLINK.exec(src))) {
      const labelOffset = n[0].charAt(0) === '!' ? 2 : 1;
      if (linkInText(src, n[1], labelOffset, this)) return undefined;
      const r = links[normLabel(n[2] || n[1])];
      if (!r) {
        const o = n[0].charAt(0);
        return { type: 'text', raw: o, text: o };
      }
      return buildLinkToken(n, r, n[0], this.lexer);
    }
  }
  emStrong(src, masked, prev = '') {
    const s = EM_LDELIM.exec(src);
    if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return undefined;
    const delim = s[0][0];
    const prevIsDelim = prev === delim;
    const i = masked.length - src.length;
    let l = i;
    for (; l > 0 && masked[l - 1] === delim;) l--;
    const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
    const h = p === '*' || p === '_' || !!PUNCTUATION_RE.exec(p);
    if (l < i) prev = p;
    const u = l < i ? h : !!PUNCTUATION_RE.exec(prev);
    if (s[4] && prev.match(UNICODE_ALNUM)) return undefined;
    const d = s[1] || s[3] || '';
    if (!d || !prev || u) {
      let k = [...s[0]].length - 1;
      let g, b, m = k, f = 0;
      const y = i - l + k;
      const R = !!p.trim() && (!!d || (delim === '*' && !h));
      if (delim !== '*' && delim !== '_') return undefined;
      const A = delim === '*' ? EM_RDELIM_AST : EM_RDELIM_UND;
      const v = lastEmCloser(this, masked, delim);
      const Q = masked.length - src.length + k;
      if (v < Q) return undefined;
      masked = masked.slice(-src.length + k);
      const ee = v - Q;
      let cap;
      for (A.lastIndex = 0; (cap = A.exec(masked)) !== null && !(cap.index > ee);) {
        if (g = cap[1] || cap[2] || cap[3] || cap[4] || cap[5] || cap[6], !g) continue;
        b = [...g].length;
        if (cap[3] || cap[4]) { m += b; continue; }
        else if (cap[5] || cap[6] || R) {
          if (prevIsDelim && (cap[5] || cap[6])) break;
          if (y % 3 && !((y + b) % 3)) { f += b; continue; }
        }
        if (m -= b, m > 0) continue;
        b = Math.min(b, b + m + f);
        const te = [...cap[0]][0].length;
        const M = src.slice(0, k + cap.index + te + b);
        if (Math.min(k, b) % 2) {
          const U = M.slice(1, -1);
          return { type: 'em', raw: M, text: U, tokens: this.lexer.inlineTokens(U) };
        }
        const ne = M.slice(2, -2);
        return { type: 'strong', raw: M, text: ne, tokens: this.lexer.inlineTokens(ne) };
      }
    }
    return undefined;
  }
  codespan(src) {
    const t = INLINE_CODE.exec(src);
    if (t) {
      let n = t[2].replace(NEWLINE_GLOBAL, ' ');
      const s = NON_SPACE_CHAR.test(n);
      const r = STARTING_SPACE_CHAR.test(n) && ENDING_SPACE_CHAR.test(n);
      if (s && r) n = n.substring(1, n.length - 1);
      return { type: 'codespan', raw: t[0], text: n };
    }
  }
  br(src) {
    const t = INLINE_BR.exec(src);
    if (t) return { type: 'br', raw: t[0] };
  }
  del(src, masked, prev = '') {
    const s = DEL_LDELIM.exec(src);
    if (!s) return undefined;
    if (!(s[1] || '') || !prev || PUNCTUATION_RE.exec(prev)) {
      const o = [...s[0]].length - 1;
      let i, l, p = o;
      const h = DEL_RDELIM;
      const u = lastDelCloser(this, masked);
      const d = masked.length - src.length + o;
      if (u < d) return undefined;
      masked = masked.slice(-src.length + o);
      const k = u - d;
      let cap;
      for (h.lastIndex = 0; (cap = h.exec(masked)) !== null && !(cap.index > k);) {
        if (i = cap[1] || cap[2] || cap[3] || cap[4] || cap[5] || cap[6], !i || (l = [...i].length, l !== o)) continue;
        if (cap[3] || cap[4]) { p += l; continue; }
        if (p -= l, p > 0) continue;
        l = Math.min(l, l + p);
        const g = [...cap[0]][0].length;
        const b = src.slice(0, o + cap.index + g + l);
        const m = b.slice(o, -o);
        return { type: 'del', raw: b, text: m, tokens: this.lexer.inlineTokens(m) };
      }
    }
    return undefined;
  }
  autolink(src) {
    const t = INLINE_AUTOLINK.exec(src);
    if (t) {
      let n, s;
      if (t[2] === '@') { n = t[1]; s = 'mailto:' + n; }
      else { n = t[1]; s = n; }
      return { type: 'link', raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: 'text', raw: n, text: n }] };
    }
  }
  url(src) {
    const t = INLINE_URL.exec(src);
    if (t) {
      let n, s;
      if (t[2] === '@') { n = t[0]; s = 'mailto:' + n; }
      else {
        let r;
        do { r = t[0]; t[0] = BACKPEDAL.exec(t[0])?.[0] ?? ''; } while (r !== t[0]);
        n = t[0];
        s = t[1] === 'www.' ? 'http://' + t[0] : t[0];
      }
      return { type: 'link', raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: 'text', raw: n, text: n }] };
    }
  }
  inlineText(src) {
    const t = INLINE_TEXT.exec(src);
    if (t) {
      const n = this.lexer.state.inRawBlock;
      return { type: 'text', raw: t[0], text: n ? t[0] : unescapeHtml(t[0]), escaped: n };
    }
  }
}

// ---- lexer -------------------------------------------------------------------
class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }
  static lex(src) { return new Lexer().lex(src); }
  lex(src) {
    src = src.replace(CARRIAGE_RETURN, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }
  // Queue inline lexing of src (deferred until lex() finishes block lexing).
  inline(src) {
    const tokens = [];
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }
  inlineTokens(src, tokens = []) {
    // Fast path: text with no inline trigger at all lexes as a single text
    // token (identical output: no rule can fire, inlineText consumes it whole).
    if (!INLINE_PLAIN.test(src)) { const rb = this.state.inRawBlock; tokens.push({ type: 'text', raw: src, text: src, escaped: rb }); return tokens; }
    this.tokenizer.lexer = this;
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineLex(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }
  // Does the label text contain a link/autolink? (Used by the mask and by
  // link/reflink to reject labels that already contain a link.)
  linkInText(label) {
    if (!label.includes('[')) return false;
    for (const n of label.matchAll(BLOCK_SKIP)) {
      if (INLINE_LINK.test(n[0]) && label.charAt(n.index - 1) !== '!') return true;
    }
    for (const n of label.matchAll(INLINE_REFLINK_SEARCH)) {
      const s = n[0];
      const r = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normLabel(s.slice(r + 1, -1))))
        && !(r > 1 && this.linkInText(s.slice(1, r - 1)))) return true;
    }
    return false;
  }
  // Inline lexing with the emphasis mask (the two-step mask).
  inlineLex(src, tokens) {
    const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(this, src) : src;
    pushMask(this.tokenizer, masked);
    try {
      return this.inlineLoop(src, masked, tokens);
    } finally {
      popMask(this.tokenizer);
    }
  }
  inlineLoop(src, masked, tokens) {
    let wasText = false;
    let prevChar = '';
    let shortest = Infinity;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      if (!wasText) prevChar = '';
      wasText = false;
      let tok;
      if (tok = this.tokenizer.escape(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.tag(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.link(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.reflink(src, this.tokens.links)) {
        src = src.substring(tok.raw.length);
        const p = tokens.at(-1);
        if (tok.type === 'text' && p?.type === 'text') { p.raw += tok.raw; p.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (tok = this.tokenizer.emStrong(src, masked, prevChar)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.codespan(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.br(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.del(src, masked, prevChar)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.autolink(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (!this.state.inLink && (tok = this.tokenizer.url(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.inlineText(src)) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        wasText = true;
        const p = tokens.at(-1);
        if (p?.type === 'text') { p.raw += tok.raw; p.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (src) { this.infiniteLoopError(src.charCodeAt(0)); break; }
    }
    return tokens;
  }
  blockTokens(src, tokens = [], inBlockquote = false) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else { this.infiniteLoopError(src.charCodeAt(0)); break; }
      let tok;
      if (tok = this.tokenizer.space(src)) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if (tok = this.tokenizer.code(src)) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (tok = this.tokenizer.fences(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.heading(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.hr(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.blockquote(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.list(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.html(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.def(src)) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if (tok = this.tokenizer.table(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = this.tokenizer.lheading(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      const rest = src;
      if (this.state.top && (tok = this.tokenizer.paragraph(rest))) {
        const prev = tokens.at(-1);
        if (inBlockquote && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        inBlockquote = rest.length !== src.length;
        src = src.substring(tok.raw.length);
        continue;
      }
      if (tok = this.tokenizer.text(src)) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) { this.infiniteLoopError(src.charCodeAt(0)); break; }
    }
    this.state.top = true;
    return tokens;
  }
  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}

// ---- renderer ----------------------------------------------------------------
class Renderer {
  constructor() { this.parser = null; }
  space() { return ''; }
  code({ text, lang, escaped }) {
    const s = (lang || '').match(NOT_SPACE_START)?.[0];
    const r = text ? text.replace(ENDING_NEWLINE, '') + '\n' : '';
    const body = escaped ? r : escapeHtml(r, true);
    return s
      ? `<pre><code class="language-${escapeHtml(s)}">${body}</code></pre>\n`
      : `<pre><code>${body}</code></pre>\n`;
  }
  blockquote({ tokens }) { return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`; }
  html({ text }) { return text; }
  def() { return ''; }
  heading({ tokens, depth }) { return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`; }
  hr() { return '<hr>\n'; }
  list({ ordered, start, items }) {
    let s = '';
    for (let i = 0; i < items.length; i++) s += this.listitem(items[i]);
    const tag = ordered ? 'ol' : 'ul';
    const o = ordered && start !== 1 ? ` start="${start}"` : '';
    return `<${tag}${o}>\n${s}</${tag}>\n`;
  }
  listitem({ tokens }) { return `<li>${this.parser.parse(tokens)}</li>\n`; }
  checkbox({ checked }) { return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; }
  paragraph({ tokens }) { return `<p>${this.parser.parseInline(tokens)}</p>\n`; }
  table({ header, rows }) {
    let n = '';
    for (let r = 0; r < header.length; r++) n += this.tablecell(header[r]);
    let t = this.tablerow({ text: n });
    let s = '';
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      n = '';
      for (let i = 0; i < row.length; i++) n += this.tablecell(row[i]);
      s += this.tablerow({ text: n });
    }
    if (s) s = `<tbody>${s}</tbody>`;
    return `<table>\n<thead>\n${t}</thead>\n${s}</table>\n`;
  }
  tablerow({ text }) { return `<tr>\n${text}</tr>\n`; }
  tablecell({ tokens, header, align }) {
    const t = this.parser.parseInline(tokens);
    const n = header ? 'th' : 'td';
    return (align ? `<${n} align="${align}">` : `<${n}>`) + t + `</${n}>\n`;
  }
  strong({ tokens }) { return `<strong>${this.parser.parseInline(tokens)}</strong>`; }
  em({ tokens }) { return `<em>${this.parser.parseInline(tokens)}</em>`; }
  codespan({ text }) { return `<code>${escapeHtml(text, true)}</code>`; }
  br() { return '<br>'; }
  del({ tokens }) { return `<del>${this.parser.parseInline(tokens)}</del>`; }
  link({ href, title, text, tokens, autolink }) {
    const o = autolink ? escapeHtml(text, true) : this.parser.parseInline(tokens);
    const i = encodeHref(href);
    if (i === null) return o;
    const e = escapeHtml(i, autolink);
    let l = `<a href="${e}"`;
    if (title) l += ` title="${escapeHtml(title)}"`;
    return l + `>${o}</a>`;
  }
  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const r = encodeHref(href);
    if (r === null) return escapeHtml(text);
    const e = r;
    let o = `<img src="${escapeHtml(e)}" alt="${escapeHtml(text)}"`;
    if (title) o += ` title="${escapeHtml(title)}"`;
    return o + '>';
  }
  text(e) {
    return 'tokens' in e && e.tokens
      ? this.parser.parseInline(e.tokens)
      : 'escaped' in e && e.escaped ? e.text : escapeHtml(e.text);
  }
}
class TextRenderer {
  constructor() { this.parser = null; }
  strong({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  em({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  codespan({ text }) { return text; }
  del({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  html({ text }) { return text; }
  text({ text }) { return text; }
  link({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  image({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  br() { return ''; }
  checkbox({ raw }) { return raw; }
}
class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }
  static parse(tokens) { return new Parser().parse(tokens); }
  parse(tokens) {
    this.renderer.parser = this;
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      switch (tok.type) {
        case 'space': out += this.renderer.space(tok); break;
        case 'hr': out += this.renderer.hr(tok); break;
        case 'heading': out += this.renderer.heading(tok); break;
        case 'code': out += this.renderer.code(tok); break;
        case 'table': out += this.renderer.table(tok); break;
        case 'blockquote': out += this.renderer.blockquote(tok); break;
        case 'list': out += this.renderer.list(tok); break;
        case 'checkbox': out += this.renderer.checkbox(tok); break;
        case 'html': out += this.renderer.html(tok); break;
        case 'def': out += this.renderer.def(tok); break;
        case 'paragraph': out += this.renderer.paragraph(tok); break;
        case 'text': out += this.renderer.text(tok); break;
        default: throw new Error('Token with "' + tok.type + '" type was not found.');
      }
    }
    return out;
  }
  parseInline(tokens, renderer) {
    const r = renderer || this.renderer;
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      switch (tok.type) {
        case 'escape': out += r.text(tok); break;
        case 'html': out += r.html(tok); break;
        case 'link': out += r.link(tok); break;
        case 'image': out += r.image(tok); break;
        case 'strong': out += r.strong(tok); break;
        case 'em': out += r.em(tok); break;
        case 'codespan': out += r.codespan(tok); break;
        case 'br': out += r.br(tok); break;
        case 'del': out += r.del(tok); break;
        case 'text': out += r.text(tok); break;
        case 'checkbox': out += r.checkbox(tok); break;
        default: throw new Error('Token with "' + tok.type + '" type was not found.');
      }
    }
    return out;
  }
}

// ---- entry point ---------------------------------------------------------------
export function parse(markdown) {
  if (typeof markdown === 'undefined' || markdown === null) {
    throw new Error('parse(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  if (typeof markdown !== 'string') {
    throw new Error('parse(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const tokens = Lexer.lex(markdown);
  return Parser.parse(tokens);
}
export default parse;

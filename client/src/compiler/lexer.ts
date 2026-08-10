/** Token kinds produced by the lexer (both pre-processing and final C/C++ tokens share this shape). */
export type TokenKind = 'ident' | 'num' | 'char' | 'string' | 'punct' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string; // raw spelling (identifier name, numeric literal text, punctuator, or "s" for string kind)
  value: string; // decoded value for 'char' (single-char string) and 'string' (decoded contents); unused otherwise
  line: number;
  col: number;
  file: string;
  atLineStart: boolean;
  spaceBefore: boolean;
  /** For macro-expanded tokens: names that must not be re-expanded from this token (hide set), by macro name. */
  noExpand?: Set<string>;
}

export class LexError extends Error {
  file: string;
  line: number;
  col: number;
  constructor(message: string, file: string, line: number, col: number) {
    super(`${file}:${line}:${col}: ${message}`);
    this.file = file;
    this.line = line;
    this.col = col;
  }
}

const PUNCTUATORS3 = ['<<=', '>>=', '...'];
const PUNCTUATORS2 = [
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::',
];
const PUNCTUATORS1 = [
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~',
  '(', ')', '{', '}', '[', ']', ';', ',', '.', ':', '?', '#',
];

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/**
 * Tokenizes a single translation unit's text into preprocessing tokens.
 * Comments are stripped here (both // and slash-star), line continuations
 * (backslash-newline) are spliced before scanning.
 */
export function tokenize(source: string, file: string): Token[] {
  const src = spliceContinuations(source);
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let atLineStart = true;
  let spaceBefore = false;

  const n = src.length;
  const peek = (o = 0) => src[i + o];
  const advance = (): string => {
    const c = src[i++];
    if (c === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    return c;
  };

  while (i < n) {
    const c = peek();

    if (c === '\n') {
      advance();
      atLineStart = true;
      spaceBefore = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f') {
      advance();
      spaceBefore = true;
      continue;
    }
    if (c === '/' && peek(1) === '/') {
      while (i < n && peek() !== '\n') advance();
      spaceBefore = true;
      continue;
    }
    if (c === '/' && peek(1) === '*') {
      const startLine = line, startCol = col;
      advance();
      advance();
      let closed = false;
      while (i < n) {
        if (peek() === '*' && peek(1) === '/') {
          advance();
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) throw new LexError('unterminated block comment', file, startLine, startCol);
      spaceBefore = true;
      continue;
    }

    const startLine = line;
    const startCol = col;
    const startAtLineStart = atLineStart;
    const startSpaceBefore = spaceBefore;
    atLineStart = false;
    spaceBefore = false;

    const push = (kind: TokenKind, text: string, value = '') => {
      tokens.push({
        kind,
        text,
        value,
        line: startLine,
        col: startCol,
        file,
        atLineStart: startAtLineStart,
        spaceBefore: startSpaceBefore,
      });
    };

    if (isIdentStart(c)) {
      let s = '';
      while (i < n && isIdentPart(peek())) s += advance();
      push('ident', s);
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(peek(1) ?? ''))) {
      let s = '';
      // hex/binary prefix
      if (c === '0' && (peek(1) === 'x' || peek(1) === 'X')) {
        s += advance();
        s += advance();
        while (i < n && /[0-9a-fA-F]/.test(peek() ?? '')) s += advance();
      } else {
        while (i < n && isDigit(peek() ?? '')) s += advance();
        if (peek() === '.') {
          s += advance();
          while (i < n && isDigit(peek() ?? '')) s += advance();
        }
        if (peek() === 'e' || peek() === 'E') {
          s += advance();
          if (peek() === '+' || peek() === '-') s += advance();
          while (i < n && isDigit(peek() ?? '')) s += advance();
        }
      }
      // integer/float suffixes: u U l L f F (any combination, keep it simple/permissive)
      while (i < n && /[uUlLfF]/.test(peek() ?? '')) s += advance();
      push('num', s);
      continue;
    }

    if (c === '"') {
      const { text, value } = scanQuoted(src, () => i, advance, peek, '"', file, startLine, startCol);
      push('string', text, value);
      continue;
    }
    if (c === "'") {
      const { text, value } = scanQuoted(src, () => i, advance, peek, "'", file, startLine, startCol);
      push('char', text, value);
      continue;
    }

    const three = src.slice(i, i + 3);
    if (PUNCTUATORS3.includes(three)) {
      advance(); advance(); advance();
      push('punct', three);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCTUATORS2.includes(two)) {
      advance(); advance();
      push('punct', two);
      continue;
    }
    if (PUNCTUATORS1.includes(c)) {
      advance();
      push('punct', c);
      continue;
    }

    throw new LexError(`unexpected character '${c}'`, file, startLine, startCol);
  }

  tokens.push({
    kind: 'eof', text: '', value: '', line, col, file, atLineStart: true, spaceBefore: true,
  });
  return tokens;
}

function spliceContinuations(source: string): string {
  return source.replace(/\\\r?\n/g, '');
}

function scanQuoted(
  src: string,
  posOf: () => number,
  advance: () => string,
  peek: (o?: number) => string | undefined,
  quote: string,
  file: string,
  startLine: number,
  startCol: number,
): { text: string; value: string } {
  let raw = '';
  let value = '';
  raw += advance(); // opening quote
  while (true) {
    const c = peek();
    if (c === undefined || c === '\n') {
      throw new LexError(`unterminated ${quote === '"' ? 'string' : 'char'} literal`, file, startLine, startCol);
    }
    if (c === quote) {
      raw += advance();
      break;
    }
    if (c === '\\') {
      raw += advance();
      const esc = advance();
      raw += esc;
      switch (esc) {
        case 'n': value += '\n'; break;
        case 't': value += '\t'; break;
        case 'r': value += '\r'; break;
        case '0': value += '\0'; break;
        case '\\': value += '\\'; break;
        case "'": value += "'"; break;
        case '"': value += '"'; break;
        case 'a': value += '\x07'; break;
        case 'b': value += '\b'; break;
        case 'f': value += '\f'; break;
        case 'v': value += '\v'; break;
        case 'x': {
          let hex = '';
          while (peek() && /[0-9a-fA-F]/.test(peek()!)) {
            const h = advance();
            hex += h;
            raw += h;
          }
          value += String.fromCharCode(parseInt(hex, 16) & 0xff);
          break;
        }
        default: value += esc;
      }
      continue;
    }
    value += c;
    raw += advance();
  }
  return { text: raw, value };
}

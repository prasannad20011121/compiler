/**
 * Our own minimal C runtime, written in C and compiled by our own compiler
 * (true self-hosting — no vendored libc, no LLVM compiler-rt). Merged into
 * every program at whole-program-compile time; see driver.ts.
 *
 * `__builtin_write`/`__builtin_read`/`__builtin_exit` are ordinary imported
 * host functions (registered by the driver, not special-cased in codegen).
 * `__builtin_heap_base`/`__builtin_memory_grow`/`__builtin_memory_size`/
 * `__builtin_trap`/`__builtin_va_*` are true codegen intrinsics.
 *
 * Scope, by design: a bump allocator (free() does not reclaim memory — fine
 * for the short-lived programs this IDE runs), and a practical printf/scanf
 * subset (%d %i %u %ld %lu %x %X %o %c %s %f %p %% with width/precision/
 * zero-pad/left-align flags, but no positional args or exotic conversions).
 */
export const LIBC_SOURCE = `
typedef unsigned int size_t;
typedef char *va_list;
#define va_start(ap, last) __builtin_va_start(ap)
#define va_end(ap) __builtin_va_end(ap)

/* ---------------- string.h ---------------- */

void *memcpy(void *dest, const void *src, size_t n) {
  char *d = (char *)dest;
  const char *s = (const char *)src;
  size_t i = 0;
  while (i < n) { d[i] = s[i]; i = i + 1; }
  return dest;
}

void *memmove(void *dest, const void *src, size_t n) {
  char *d = (char *)dest;
  const char *s = (const char *)src;
  if (d < s) {
    size_t i = 0;
    while (i < n) { d[i] = s[i]; i = i + 1; }
  } else {
    size_t i = n;
    while (i > 0) { i = i - 1; d[i] = s[i]; }
  }
  return dest;
}

void *memset(void *dest, int value, size_t n) {
  char *d = (char *)dest;
  size_t i = 0;
  while (i < n) { d[i] = (char)value; i = i + 1; }
  return dest;
}

int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *pa = (const unsigned char *)a;
  const unsigned char *pb = (const unsigned char *)b;
  size_t i = 0;
  while (i < n) {
    if (pa[i] != pb[i]) return (int)pa[i] - (int)pb[i];
    i = i + 1;
  }
  return 0;
}

size_t strlen(const char *s) {
  size_t n = 0;
  while (s[n] != 0) n = n + 1;
  return n;
}

char *strcpy(char *dest, const char *src) {
  size_t i = 0;
  while (src[i] != 0) { dest[i] = src[i]; i = i + 1; }
  dest[i] = 0;
  return dest;
}

char *strncpy(char *dest, const char *src, size_t n) {
  size_t i = 0;
  while (i < n && src[i] != 0) { dest[i] = src[i]; i = i + 1; }
  while (i < n) { dest[i] = 0; i = i + 1; }
  return dest;
}

char *strcat(char *dest, const char *src) {
  size_t dlen = strlen(dest);
  strcpy(dest + dlen, src);
  return dest;
}

int strcmp(const char *a, const char *b) {
  size_t i = 0;
  while (a[i] != 0 && a[i] == b[i]) i = i + 1;
  return (int)(unsigned char)a[i] - (int)(unsigned char)b[i];
}

int strncmp(const char *a, const char *b, size_t n) {
  size_t i = 0;
  while (i < n && a[i] != 0 && a[i] == b[i]) i = i + 1;
  if (i == n) return 0;
  return (int)(unsigned char)a[i] - (int)(unsigned char)b[i];
}

char *strchr(const char *s, int c) {
  size_t i = 0;
  while (s[i] != 0) {
    if ((int)s[i] == c) return (char *)(s + i);
    i = i + 1;
  }
  if (c == 0) return (char *)(s + i);
  return 0;
}

char *strrchr(const char *s, int c) {
  size_t i = strlen(s);
  while (1) {
    if ((int)s[i] == c) return (char *)(s + i);
    if (i == 0) return 0;
    i = i - 1;
  }
}

/* ---------------- stdlib.h: bump allocator ---------------- */

static char *__heap_ptr = 0;
static char *__heap_end = 0;

static void __heap_ensure(size_t need) {
  if (__heap_ptr == 0) {
    __heap_ptr = (char *)__builtin_heap_base();
    __heap_end = __heap_ptr;
  }
  if (__heap_ptr + need > __heap_end) {
    size_t shortfall = (__heap_ptr + need) - __heap_end;
    size_t pages = (shortfall + 65535) / 65536;
    if (pages < 16) pages = 16;
    __builtin_memory_grow(pages);
    __heap_end = __heap_end + pages * 65536;
  }
}

void *malloc(size_t size) {
  size_t payload = (size + 7) & ~7;
  __heap_ensure(payload + 8);
  unsigned int *header = (unsigned int *)__heap_ptr;
  *header = (unsigned int)size;
  void *result = (void *)(__heap_ptr + 8);
  __heap_ptr = __heap_ptr + payload + 8;
  return result;
}

void free(void *ptr) {
  (void)ptr; /* bump allocator: memory is reclaimed only when the program exits */
}

void *calloc(size_t count, size_t size) {
  size_t total = count * size;
  void *p = malloc(total);
  memset(p, 0, total);
  return p;
}

void *realloc(void *ptr, size_t size) {
  if (ptr == 0) return malloc(size);
  unsigned int oldSize = *((unsigned int *)((char *)ptr - 8));
  void *n = malloc(size);
  size_t copySize = (size_t)oldSize < size ? (size_t)oldSize : size;
  memcpy(n, ptr, copySize);
  return n;
}

int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }

static unsigned int __rand_state = 1;
void srand(unsigned int seed) { __rand_state = seed; }
int rand(void) {
  __rand_state = __rand_state * 1103515245 + 12345;
  return (int)((__rand_state / 65536) % 32768);
}

void exit(int code) {
  __builtin_exit(code);
}

void abort(void) {
  __builtin_trap();
}

/* ---------------- stdio.h ---------------- */

int putchar(int c) {
  char ch = (char)c;
  __builtin_write(1, &ch, 1);
  return c;
}

int puts(const char *s) {
  __builtin_write(1, s, strlen(s));
  char nl = 10;
  __builtin_write(1, &nl, 1);
  return 0;
}

static void __print_uint_base(unsigned long v, int base, int upper, char *out, int *outLen) {
  char buf[32];
  int n = 0;
  const char *digitsLower = "0123456789abcdef";
  const char *digitsUpper = "0123456789ABCDEF";
  const char *digits = upper ? digitsUpper : digitsLower;
  if (v == 0) { buf[n] = '0'; n = n + 1; }
  while (v > 0) {
    buf[n] = digits[v % (unsigned long)base];
    n = n + 1;
    v = v / (unsigned long)base;
  }
  int i = 0;
  while (i < n) { out[i] = buf[n - 1 - i]; i = i + 1; }
  *outLen = n;
}

static void __pad(int fd, char c, int count) {
  int i = 0;
  while (i < count) { __builtin_write(fd, &c, 1); i = i + 1; }
}

int vfprintf_fd(int fd, const char *fmt, va_list ap) {
  size_t i = 0;
  int total = 0;
  while (fmt[i] != 0) {
    if (fmt[i] != '%') {
      char c = fmt[i];
      __builtin_write(fd, &c, 1);
      i = i + 1;
      total = total + 1;
      continue;
    }
    i = i + 1; /* consume '%' */
    int leftAlign = 0, zeroPad = 0;
    while (fmt[i] == '-' || fmt[i] == '0') {
      if (fmt[i] == '-') leftAlign = 1; else zeroPad = 1;
      i = i + 1;
    }
    int width = 0;
    while (fmt[i] >= '0' && fmt[i] <= '9') { width = width * 10 + (fmt[i] - '0'); i = i + 1; }
    int prec = -1;
    if (fmt[i] == '.') {
      i = i + 1;
      prec = 0;
      while (fmt[i] >= '0' && fmt[i] <= '9') { prec = prec * 10 + (fmt[i] - '0'); i = i + 1; }
    }
    int longMod = 0;
    while (fmt[i] == 'l') { longMod = longMod + 1; i = i + 1; }
    char conv = fmt[i];
    i = i + 1;

    char numbuf[40];
    char out[48];
    int outLen = 0;
    int isNeg = 0;

    if (conv == 'd' || conv == 'i') {
      long v = longMod ? __builtin_va_arg_i64(ap) : (long)__builtin_va_arg_i32(ap);
      if (v < 0) { isNeg = 1; v = -v; }
      __print_uint_base((unsigned long)v, 10, 0, numbuf, &outLen);
    } else if (conv == 'u') {
      unsigned long v = longMod ? (unsigned long)__builtin_va_arg_i64(ap) : (unsigned long)(unsigned int)__builtin_va_arg_i32(ap);
      __print_uint_base(v, 10, 0, numbuf, &outLen);
    } else if (conv == 'x' || conv == 'X') {
      unsigned long v = longMod ? (unsigned long)__builtin_va_arg_i64(ap) : (unsigned long)(unsigned int)__builtin_va_arg_i32(ap);
      __print_uint_base(v, 16, conv == 'X', numbuf, &outLen);
    } else if (conv == 'o') {
      unsigned long v = longMod ? (unsigned long)__builtin_va_arg_i64(ap) : (unsigned long)(unsigned int)__builtin_va_arg_i32(ap);
      __print_uint_base(v, 8, 0, numbuf, &outLen);
    } else if (conv == 'p') {
      unsigned long v = (unsigned long)(unsigned int)__builtin_va_arg_i32(ap);
      int hexLen = 0;
      __print_uint_base(v, 16, 0, out, &hexLen);
      numbuf[0] = '0'; numbuf[1] = 'x';
      int k = 0;
      while (k < hexLen) { numbuf[2 + k] = out[k]; k = k + 1; }
      outLen = 2 + hexLen;
    } else if (conv == 'c') {
      int v = __builtin_va_arg_i32(ap);
      numbuf[0] = (char)v;
      outLen = 1;
    } else if (conv == 's') {
      int v = __builtin_va_arg_i32(ap);
      char *s = (char *)v;
      int len = (int)strlen(s);
      if (prec >= 0 && prec < len) len = prec;
      int padLen = width > len ? width - len : 0;
      if (!leftAlign) __pad(fd, ' ', padLen);
      __builtin_write(fd, s, len);
      if (leftAlign) __pad(fd, ' ', padLen);
      total = total + (len > width ? len : width);
      continue;
    } else if (conv == 'f') {
      double v = __builtin_va_arg_f64(ap);
      if (v < 0) { isNeg = 1; v = -v; }
      int p = prec < 0 ? 6 : prec;
      long ip = (long)v;
      double frac = v - (double)ip;
      int fl = 0;
      __print_uint_base((unsigned long)ip, 10, 0, numbuf, &fl);
      int j = fl;
      if (p > 0) {
        numbuf[j] = '.'; j = j + 1;
        int k = 0;
        while (k < p) {
          frac = frac * 10.0;
          long digit = (long)frac;
          frac = frac - (double)digit;
          numbuf[j] = (char)('0' + digit);
          j = j + 1;
          k = k + 1;
        }
      }
      outLen = j;
    } else if (conv == '%') {
      numbuf[0] = '%';
      outLen = 1;
    } else {
      numbuf[0] = '%';
      numbuf[1] = conv;
      outLen = 2;
    }

    int digitLen = outLen + isNeg;
    int padLen = width > digitLen ? width - digitLen : 0;
    if (!leftAlign && zeroPad && isNeg) { char m = '-'; __builtin_write(fd, &m, 1); isNeg = 0; }
    if (!leftAlign) __pad(fd, zeroPad ? '0' : ' ', padLen);
    if (isNeg) { char m = '-'; __builtin_write(fd, &m, 1); }
    __builtin_write(fd, numbuf, outLen);
    if (leftAlign) __pad(fd, ' ', padLen);
    total = total + (digitLen > width ? digitLen : width);
  }
  return total;
}

int printf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfprintf_fd(1, fmt, ap);
  va_end(ap);
  return r;
}

int fprintf(int fd, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfprintf_fd(fd, fmt, ap);
  va_end(ap);
  return r;
}

int sprintf(char *out, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  size_t i = 0;
  int total = 0;
  while (fmt[i] != 0) {
    if (fmt[i] != '%') { out[total] = fmt[i]; total = total + 1; i = i + 1; continue; }
    i = i + 1;
    if (fmt[i] == '%') { out[total] = '%'; total = total + 1; i = i + 1; continue; }
    char conv = fmt[i];
    i = i + 1;
    char numbuf[40];
    int outLen = 0;
    if (conv == 'd') {
      int v = __builtin_va_arg_i32(ap);
      int neg = v < 0;
      unsigned int uv = neg ? (unsigned int)(-v) : (unsigned int)v;
      __print_uint_base((unsigned long)uv, 10, 0, numbuf, &outLen);
      if (neg) { out[total] = '-'; total = total + 1; }
    } else if (conv == 's') {
      char *s = (char *)__builtin_va_arg_i32(ap);
      int len = (int)strlen(s);
      int k = 0;
      while (k < len) { out[total] = s[k]; total = total + 1; k = k + 1; }
      continue;
    } else if (conv == 'c') {
      out[total] = (char)__builtin_va_arg_i32(ap);
      total = total + 1;
      continue;
    } else {
      continue;
    }
    int k = 0;
    while (k < outLen) { out[total] = numbuf[k]; total = total + 1; k = k + 1; }
  }
  out[total] = 0;
  va_end(ap);
  return total;
}

/* ---------------- minimal stdin scanning ---------------- */

int getchar(void) {
  char c;
  int n = __builtin_read(0, &c, 1);
  if (n <= 0) return -1;
  return (int)(unsigned char)c;
}

static int __skip_ws(void) {
  int c;
  do { c = getchar(); } while (c == ' ' || c == 9 || c == 10 || c == 13);
  return c;
}

int scanf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  size_t i = 0;
  int count = 0;
  while (fmt[i] != 0) {
    if (fmt[i] == ' ' || fmt[i] == 9 || fmt[i] == 10) { i = i + 1; continue; }
    if (fmt[i] != '%') { i = i + 1; continue; }
    i = i + 1;
    char conv = fmt[i];
    i = i + 1;
    if (conv == 'd') {
      int c = __skip_ws();
      int neg = 0;
      if (c == '-') { neg = 1; c = getchar(); }
      int v = 0;
      int any = 0;
      while (c >= '0' && c <= '9') { v = v * 10 + (c - '0'); c = getchar(); any = 1; }
      if (!any) { va_end(ap); return count; }
      int *dest = (int *)__builtin_va_arg_i32(ap);
      *dest = neg ? -v : v;
      count = count + 1;
    } else if (conv == 's') {
      int c = __skip_ws();
      char *dest = (char *)__builtin_va_arg_i32(ap);
      int n = 0;
      while (c > 32) { dest[n] = (char)c; n = n + 1; c = getchar(); }
      dest[n] = 0;
      if (n == 0) { va_end(ap); return count; }
      count = count + 1;
    } else if (conv == 'c') {
      int c = getchar();
      char *dest = (char *)__builtin_va_arg_i32(ap);
      *dest = (char)c;
      count = count + 1;
    }
  }
  va_end(ap);
  return count;
}
`;

/*
 *  Copyright 2026 the original author or authors.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
package org.teavm.classlib.java.util;

import java.io.IOException;
import org.teavm.classlib.java.io.TInputStream;
import org.teavm.classlib.java.lang.TAutoCloseable;
import org.teavm.classlib.java.lang.TObject;

/**
 * A pragmatic, from-scratch {@code java.util.Scanner} substitute. TeaVM's classlib doesn't
 * implement Scanner at all, and the natural alternative - BufferedReader wrapping an
 * InputStreamReader - pulls in java.nio's TByteBuffer/TCharBuffer, which have JS-target-only
 * code paths (guarded by runtime PlatformDetector checks, not compile-time exclusion) that the
 * Wasm-GC backend's {@code @JSByRef} validation rejects outright, regardless of which branch
 * would actually run. Rather than fix that NIO-wide issue, this reads bytes directly off the
 * underlying TInputStream and decodes UTF-8 by hand (mirroring the approach
 * WasmGCSupport.nextCharArray() already uses elsewhere in this fork), sidestepping NIO
 * entirely. Covers the common subset real programs use: next/nextLine and the numeric/boolean
 * variants, whitespace-delimited tokenizing, and the hasNextXxx() peek forms. Four-byte UTF-8
 * sequences (astral code points) decode to the replacement character rather than a correct
 * surrogate pair - a deliberate simplification, since console input essentially never contains
 * them.
 */
public class TScanner extends TObject implements TAutoCloseable {
    private TInputStream stream;
    private String source;
    private int sourcePos;
    private final StringBuilder pending = new StringBuilder();
    private boolean closed;

    public TScanner(TInputStream in) {
        this.stream = in;
    }

    public TScanner(String source) {
        this.source = source;
    }

    private int readRawChar() {
        if (closed) {
            return -1;
        }
        if (source != null) {
            return sourcePos < source.length() ? source.charAt(sourcePos++) : -1;
        }
        int b0 = streamReadByte();
        if (b0 < 0) {
            return -1;
        }
        if ((b0 & 0x80) == 0) {
            return b0;
        } else if ((b0 & 0xE0) == 0xC0) {
            int b1 = streamReadByte();
            return b1 < 0 ? b0 : (((b0 & 0x1F) << 6) | (b1 & 0x3F));
        } else if ((b0 & 0xF0) == 0xE0) {
            int b1 = streamReadByte();
            int b2 = streamReadByte();
            return (b1 < 0 || b2 < 0) ? b0 : (((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F));
        } else {
            streamReadByte();
            streamReadByte();
            streamReadByte();
            return '�';
        }
    }

    private int streamReadByte() {
        try {
            return stream.read();
        } catch (IOException e) {
            return -1;
        }
    }

    private int nextChar() {
        if (pending.length() > 0) {
            char c = pending.charAt(0);
            pending.deleteCharAt(0);
            return c;
        }
        return readRawChar();
    }

    private void pushBack(String s) {
        pending.insert(0, s);
    }

    private static boolean isWhitespace(int c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == 0x0B;
    }

    /** Skips leading whitespace and returns the first non-whitespace char, or -1 at end of input. */
    private int skipWhitespace() {
        int c = nextChar();
        while (c >= 0 && isWhitespace(c)) {
            c = nextChar();
        }
        return c;
    }

    public boolean hasNextLine() {
        if (source == null) {
            // Interactive console input has no real EOF in this environment - reads simply
            // block for more. Matches the C/C++ and Python workers' own stdin behavior here.
            return true;
        }
        int c = skipWhitespaceForLine();
        if (c < 0) {
            return false;
        }
        pushBack(String.valueOf((char) c));
        return true;
    }

    private int skipWhitespaceForLine() {
        // hasNextLine() must not skip whitespace - only peek whether *anything* remains,
        // including a lone blank line.
        int c = nextChar();
        if (c >= 0) {
            pushBack(String.valueOf((char) c));
        }
        return c;
    }

    public String nextLine() {
        int c = nextChar();
        if (c < 0) {
            throw new TNoSuchElementException("No line found");
        }
        StringBuilder sb = new StringBuilder();
        while (c >= 0 && c != '\n') {
            if (c != '\r') {
                sb.append((char) c);
            }
            c = nextChar();
        }
        return sb.toString();
    }

    public boolean hasNext() {
        int c = skipWhitespace();
        if (c < 0) {
            return false;
        }
        pushBack(String.valueOf((char) c));
        return true;
    }

    public String next() {
        int c = skipWhitespace();
        if (c < 0) {
            throw new TNoSuchElementException();
        }
        StringBuilder sb = new StringBuilder();
        while (c >= 0 && !isWhitespace(c)) {
            sb.append((char) c);
            c = nextChar();
        }
        if (c >= 0) {
            pushBack(String.valueOf((char) c));
        }
        return sb.toString();
    }

    private String peekToken() {
        if (!hasNext()) {
            return null;
        }
        String tok = next();
        pushBack(tok);
        return tok;
    }

    public boolean hasNextInt() {
        String tok = peekToken();
        if (tok == null) {
            return false;
        }
        try {
            Integer.parseInt(tok);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public int nextInt() {
        String tok = next();
        try {
            return Integer.parseInt(tok);
        } catch (NumberFormatException e) {
            pushBack(tok);
            throw new TInputMismatchException("For input string: \"" + tok + "\"");
        }
    }

    public boolean hasNextLong() {
        String tok = peekToken();
        if (tok == null) {
            return false;
        }
        try {
            Long.parseLong(tok);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public long nextLong() {
        String tok = next();
        try {
            return Long.parseLong(tok);
        } catch (NumberFormatException e) {
            pushBack(tok);
            throw new TInputMismatchException("For input string: \"" + tok + "\"");
        }
    }

    public boolean hasNextDouble() {
        String tok = peekToken();
        if (tok == null) {
            return false;
        }
        try {
            Double.parseDouble(tok);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public double nextDouble() {
        String tok = next();
        try {
            return Double.parseDouble(tok);
        } catch (NumberFormatException e) {
            pushBack(tok);
            throw new TInputMismatchException("For input string: \"" + tok + "\"");
        }
    }

    public boolean hasNextFloat() {
        return hasNextDouble();
    }

    public float nextFloat() {
        return (float) nextDouble();
    }

    public boolean hasNextBoolean() {
        String tok = peekToken();
        return tok != null && (tok.equalsIgnoreCase("true") || tok.equalsIgnoreCase("false"));
    }

    public boolean nextBoolean() {
        String tok = next();
        if (tok.equalsIgnoreCase("true")) {
            return true;
        }
        if (tok.equalsIgnoreCase("false")) {
            return false;
        }
        pushBack(tok);
        throw new TInputMismatchException("For input string: \"" + tok + "\"");
    }

    public void close() {
        closed = true;
        pending.setLength(0);
    }
}

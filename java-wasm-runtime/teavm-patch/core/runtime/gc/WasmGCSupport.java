/*
 *  Copyright 2024 Alexey Andreev.
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
package org.teavm.backend.wasm.runtime.gc;

import org.teavm.interop.Import;

public class WasmGCSupport {
    private static int lastObjectId = 1831433054;

    private WasmGCSupport() {
    }

    public static NullPointerException npe() {
        return new NullPointerException();
    }

    public static ArrayIndexOutOfBoundsException aiiobe() {
        return new ArrayIndexOutOfBoundsException();
    }

    public static ClassCastException cce() {
        return new ClassCastException();
    }

    public static ArithmeticException ae() {
        return new ArithmeticException("/ by zero");
    }

    public static void throwCloneNotSupportedException() throws CloneNotSupportedException {
        throw new CloneNotSupportedException();
    }

    public static Object defaultClone(Object object) throws CloneNotSupportedException {
        throw new CloneNotSupportedException();
    }

    public static int nextObjectId() {
        var x = lastObjectId;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        lastObjectId = x;
        return x;
    }

    @Import(name = "putcharStdout", module = "teavmConsole")
    public static native void putCharStdout(char c);

    @Import(name = "putcharStderr", module = "teavmConsole")
    public static native void putCharStderr(char c);

    // Blocks the whole worker thread (via a JS-side Atomics.wait on a SharedArrayBuffer) until
    // a byte of real stdin input is available, returning it as 0-255. There's no EOF signal from
    // the browser terminal in this environment (no "close stdin" affordance), so this never
    // returns -1 - every read either yields a real byte or blocks indefinitely, matching the
    // C/C++ and Python workers' own interactive-stdin behavior in this same IDE.
    @Import(name = "readStdinByte", module = "teavmConsole")
    public static native int readStdinByte();

    public static char[] nextCharArray() {
        var length = nextLEB();
        var result = new char[length];
        var pos = 0;
        while (pos < length) {
            var b = nextByte();
            if ((b & 0x80) == 0) {
                result[pos++] = (char) b;
            } else if ((b & 0xE0) == 0xC0) {
                var b2 = nextByte();
                result[pos++] = (char) (((b & 0x1F) << 6) | (b2 & 0x3F));
            } else if ((b & 0xF0) == 0xE0) {
                var b2 = nextByte();
                var b3 = nextByte();
                var c = (char) (((b & 0x0F) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3F));
                result[pos++] = c;
            } else if ((b & 0xF8) == 0xF0) {
                var b2 = nextByte();
                var b3 = nextByte();
                var b4 = nextByte();
                var code = ((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F);
                result[pos++] = Character.highSurrogate(code);
                result[pos++] = Character.lowSurrogate(code);
            }
        }
        return result;
    }

    private static int nextLEB() {
        var shift = 0;
        var result = 0;
        while (true) {
            var b = nextByte();
            var digit = b & 0x7F;
            result |= digit << shift;
            if ((b & 0x80) == 0) {
                break;
            }
            shift += 7;
        }
        return result;
    }

    private static native byte nextByte();

    private static native void error();

    public static StringBuilder createStringBuilder() {
        return new StringBuilder();
    }

    public static String[] createStringArray(int size) {
        return new String[size];
    }

    public static void setToStringArray(String[] array, int index, String value) {
        array[index] = value;
    }
}

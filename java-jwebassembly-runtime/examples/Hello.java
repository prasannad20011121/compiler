import de.inetsoftware.jwebassembly.api.annotation.Export;
import de.inetsoftware.jwebassembly.api.annotation.Import;

/**
 * Minimal but non-trivial JWebAssembly demo: console output built from
 * scratch (System.out.println doesn't compile - see README "What's broken"),
 * a real String (length()/charAt()), and an allocated instance with a field.
 *
 * Exported entry point is run(a, b): prints two lines, then returns a + b
 * routed through an instance field to also exercise object allocation.
 */
public class Hello {

    @Import(module = "console", name = "putchar")
    static native void putChar(int ch);

    static void print(String s) {
        for (int i = 0; i < s.length(); i++) {
            putChar(s.charAt(i));
        }
    }

    static void println(String s) {
        print(s);
        putChar('\n');
    }

    private int value;

    Hello(int v) {
        this.value = v;
    }

    int getValue() {
        return value;
    }

    @Export
    public static int run(int a, int b) {
        println("Hello from Java via JWebAssembly!");
        Hello h = new Hello(a);
        int sum = h.getValue() + b;
        println("sum computed");
        return sum;
    }
}

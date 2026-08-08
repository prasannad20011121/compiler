import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T13Varargs {
    static int sum(int... vals) {
        int s = 0;
        for (int v : vals) s += v;
        return s;
    }

    @Export
    public static int run(int a, int b, int c) {
        return sum(a, b, c, 100);
    }
}

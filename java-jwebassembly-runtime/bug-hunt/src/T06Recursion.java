import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T06Recursion {
    static int fib(int n) {
        if (n < 2) return n;
        return fib(n - 1) + fib(n - 2);
    }

    @Export
    public static int run(int n) {
        return fib(n);
    }
}

import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T09Long {
    @Export
    public static long run(int n) {
        long acc = 1L;
        for (int i = 1; i <= n; i++) {
            acc *= i;
        }
        return acc;
    }
}

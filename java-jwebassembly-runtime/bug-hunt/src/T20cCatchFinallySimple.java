import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T20cCatchFinallySimple {
    @Export
    public static int run(int a, int b) {
        int x = 0;
        try {
            x = a / b;
        } catch (ArithmeticException e) {
            x = -1;
        } finally {
            x += 100;
        }
        return x;
    }
}

import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T23NestedTry {
    @Export
    public static int run(int a, int b) {
        try {
            try {
                return a / b;
            } catch (ArithmeticException e) {
                return -1;
            }
        } catch (RuntimeException e) {
            return -2;
        }
    }
}

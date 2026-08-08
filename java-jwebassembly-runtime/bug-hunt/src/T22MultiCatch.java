import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T22MultiCatch {
    @Export
    public static int run(int a, int b) {
        try {
            return a / b;
        } catch (ArithmeticException | NullPointerException e) {
            return -1;
        }
    }
}

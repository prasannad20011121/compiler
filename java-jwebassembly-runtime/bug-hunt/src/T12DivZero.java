import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T12DivZero {
    @Export
    public static int run(int a, int b) {
        try {
            return a / b;
        } catch (ArithmeticException e) {
            return -999;
        }
    }
}

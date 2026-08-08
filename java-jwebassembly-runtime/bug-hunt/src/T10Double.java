import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T10Double {
    @Export
    public static double run(double x, double y) {
        return Math.sqrt(x * x + y * y);
    }
}

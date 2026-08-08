import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T07Static {
    static int counter;
    static int base;

    static {
        base = 1000;
    }

    @Export
    public static int next() {
        counter++;
        return base + counter;
    }
}

import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T18Boxing {
    static int add(Integer a, Integer b) {
        return a + b;
    }

    @Export
    public static int run(int a, int b) {
        Integer boxedA = a;
        Integer boxedB = b;
        return add(boxedA, boxedB) + Integer.parseInt("7");
    }
}

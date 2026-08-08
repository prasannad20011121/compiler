import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T11NPE {
    static class Box {
        int v;
    }

    @Export
    public static int run(int makeNull) {
        try {
            Box b = makeNull != 0 ? null : new Box();
            b.v = 5;
            return b.v;
        } catch (NullPointerException e) {
            return -1;
        }
    }
}

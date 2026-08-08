import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T15Lambda {
    interface IntOp {
        int apply(int x);
    }

    @Export
    public static int run(int v) {
        IntOp doubler = x -> x * 2;
        return doubler.apply(v);
    }
}

import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T04Interface {
    interface Op {
        int apply(int a, int b);
    }

    static class Add implements Op {
        public int apply(int a, int b) { return a + b; }
    }

    static class Mul implements Op {
        public int apply(int a, int b) { return a * b; }
    }

    @Export
    public static int run(int a, int b) {
        Op add = new Add();
        Op mul = new Mul();
        return add.apply(a, b) + mul.apply(a, b);
    }
}

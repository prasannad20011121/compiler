import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T14Generics {
    static class Box<T> {
        T value;
        Box(T v) { value = v; }
        T get() { return value; }
    }

    @Export
    public static int run(int v) {
        Box<Integer> box = new Box<>(v);
        return box.get() * 2;
    }
}

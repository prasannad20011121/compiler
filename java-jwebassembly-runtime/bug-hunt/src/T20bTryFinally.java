import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T20bTryFinally {
    @Export
    public static int run(int flag) {
        int x = 0;
        try {
            x = 1;
        } finally {
            x += 10;
        }
        return x;
    }
}

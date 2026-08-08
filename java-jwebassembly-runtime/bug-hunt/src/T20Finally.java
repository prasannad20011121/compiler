import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T20Finally {
    @Export
    public static int run(int flag) {
        int x = 0;
        try {
            if (flag != 0) {
                throw new RuntimeException();
            }
            x = 1;
        } catch (RuntimeException e) {
            x = 2;
        } finally {
            x += 10;
        }
        return x;
    }
}

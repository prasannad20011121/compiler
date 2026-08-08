import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T01Loop {
    @Export
    public static int sumTo(int n) {
        int sum = 0;
        for (int i = 1; i <= n; i++) {
            sum += i;
        }
        return sum;
    }
}

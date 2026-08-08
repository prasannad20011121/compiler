import de.inetsoftware.jwebassembly.api.annotation.Export;
import java.util.ArrayList;

public class T16Collections {
    @Export
    public static int run(int n) {
        ArrayList<Integer> list = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            list.add(i * i);
        }
        int sum = 0;
        for (int v : list) {
            sum += v;
        }
        return sum;
    }
}

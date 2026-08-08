import de.inetsoftware.jwebassembly.api.annotation.Export;
import java.util.Scanner;

public class T25Scanner {
    @Export
    public static int run(int dummy) {
        Scanner sc = new Scanner(System.in);
        return sc.nextInt();
    }
}

import de.inetsoftware.jwebassembly.api.annotation.Export;
import java.io.IOException;

public class T24StdinRaw {
    @Export
    public static int run(int dummy) {
        try {
            return System.in.read();
        } catch (IOException e) {
            return -1;
        }
    }
}

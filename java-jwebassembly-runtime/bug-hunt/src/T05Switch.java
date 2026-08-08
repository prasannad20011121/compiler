import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T05Switch {
    @Export
    public static int classify(int n) {
        switch (n) {
            case 0: return 100;
            case 1: return 200;
            case 2: return 300;
            default: return -1;
        }
    }
}

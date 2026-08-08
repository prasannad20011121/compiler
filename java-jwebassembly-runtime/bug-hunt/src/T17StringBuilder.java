import de.inetsoftware.jwebassembly.api.annotation.Export;
import de.inetsoftware.jwebassembly.api.annotation.Import;

public class T17StringBuilder {
    @Import(module = "console", name = "putchar")
    static native void putChar(int ch);

    static void print(String s) {
        for (int i = 0; i < s.length(); i++) putChar(s.charAt(i));
    }

    @Export
    public static int run(int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            sb.append(i).append(',');
        }
        String s = sb.toString();
        print(s);
        putChar('\n');
        return s.length();
    }
}

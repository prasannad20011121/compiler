import de.inetsoftware.jwebassembly.api.annotation.Export;
import de.inetsoftware.jwebassembly.api.annotation.Import;

public class T08StringConcat {
    @Import(module = "console", name = "putchar")
    static native void putChar(int ch);

    static void print(String s) {
        for (int i = 0; i < s.length(); i++) putChar(s.charAt(i));
    }

    @Export
    public static int run(int a, int b) {
        String s = "a=" + a + ", b=" + b + ", sum=" + (a + b);
        print(s);
        putChar('\n');
        return s.length();
    }
}

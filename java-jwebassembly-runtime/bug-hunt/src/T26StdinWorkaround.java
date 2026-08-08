import de.inetsoftware.jwebassembly.api.annotation.Export;
import de.inetsoftware.jwebassembly.api.annotation.Import;

public class T26StdinWorkaround {
    @Import(module = "console", name = "putchar")
    static native void putChar(int ch);

    @Import(module = "console", name = "readbyte")
    static native int readByte();

    static void print(String s) {
        for (int i = 0; i < s.length(); i++) putChar(s.charAt(i));
    }

    static void println(String s) {
        print(s);
        putChar('\n');
    }

    static String readLine() {
        StringBuilder sb = new StringBuilder();
        while (true) {
            int c = readByte();
            if (c < 0 || c == '\n') break;
            if (c == '\r') continue;
            sb.append((char) c);
        }
        return sb.toString();
    }

    @Export
    public static int run(int unused) {
        println("Enter a number:");
        String line = readLine();
        int n = Integer.parseInt(line);
        println("You entered: " + n);

        println("Enter your name:");
        String name = readLine();
        println("Hello, " + name + "!");

        return n * 2;
    }
}

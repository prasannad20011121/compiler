import de.inetsoftware.jwebassembly.JWebAssembly;
import java.io.File;

/**
 * Driver for the JWebAssembly compiler. Must be run with a genuine JDK 8
 * `java` (not just classes compiled with `javac --release 8` on a newer
 * JDK) — JWebAssembly resolves supporting JDK classes like java.lang.String
 * from the JVM that's running *this* driver, not from the target .class
 * file's own JDK. Under JDK 17+/25 that pulls in Unsafe-based compact-string
 * internals JWebAssembly's classlib polyfills don't cover; see README.
 *
 * Usage: java Compile <input.class> <classes-dir> <output.wasm>
 */
public class Compile {
    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            System.err.println("Usage: java Compile <input.class> <classes-dir> <output.wasm>");
            System.exit(1);
        }
        File classFile = new File(args[1], args[0]);
        File output = new File(args[2]);

        JWebAssembly wasm = new JWebAssembly();
        wasm.addFile(classFile);
        wasm.addLibrary(new File(System.getProperty("jwebassembly.api.jar")));
        wasm.compileToBinary(output);
        System.out.println("compiled OK: " + output + " (" + output.length() + " bytes)");
    }
}

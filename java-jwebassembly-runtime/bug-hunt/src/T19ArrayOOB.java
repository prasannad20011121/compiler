import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T19ArrayOOB {
    @Export
    public static int run(int idx) {
        int[] arr = new int[3];
        arr[0] = 10;
        arr[1] = 20;
        arr[2] = 30;
        return arr[idx];
    }
}

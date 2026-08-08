import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T02Array {
    @Export
    public static int sumArray(int n) {
        int[] arr = new int[n];
        for (int i = 0; i < n; i++) {
            arr[i] = i * i;
        }
        int sum = 0;
        for (int v : arr) {
            sum += v;
        }
        return sum;
    }

    @Export
    public static int sum2D(int n) {
        int[][] grid = new int[n][n];
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                grid[i][j] = i + j;
            }
        }
        int sum = 0;
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                sum += grid[i][j];
            }
        }
        return sum;
    }
}

import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T03Inherit {
    static abstract class Shape {
        abstract int area();
    }

    static class Square extends Shape {
        int side;
        Square(int side) { this.side = side; }
        int area() { return side * side; }
    }

    static class Rect extends Shape {
        int w, h;
        Rect(int w, int h) { this.w = w; this.h = h; }
        int area() { return w * h; }
    }

    @Export
    public static int totalArea(int side, int w, int h) {
        Shape[] shapes = new Shape[2];
        shapes[0] = new Square(side);
        shapes[1] = new Rect(w, h);
        int total = 0;
        for (Shape s : shapes) {
            total += s.area();
        }
        return total;
    }
}

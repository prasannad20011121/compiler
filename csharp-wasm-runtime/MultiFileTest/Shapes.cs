public abstract class Shape
{
    public abstract double Area { get; }
    public abstract double Perimeter { get; }
    public override string ToString() => $"{GetType().Name}: Area={Area:F2}, Perimeter={Perimeter:F2}";
}

public class Circle : Shape
{
    public double Radius { get; }
    public Circle(double r) { Radius = r; }
    public override double Area => Math.PI * Radius * Radius;
    public override double Perimeter => 2 * Math.PI * Radius;
}

public class Rectangle : Shape
{
    public double Width { get; }
    public double Height { get; }
    public Rectangle(double w, double h) { Width = w; Height = h; }
    public override double Area => Width * Height;
    public override double Perimeter => 2 * (Width + Height);
}

public class Triangle : Shape
{
    public double A { get; }
    public double B { get; }
    public double C { get; }
    public Triangle(double a, double b, double c) { A = a; B = b; C = c; }
    public override double Area
    {
        get
        {
            double s = (A + B + C) / 2;
            return Math.Sqrt(s * (s - A) * (s - B) * (s - C));
        }
    }
    public override double Perimeter => A + B + C;
}

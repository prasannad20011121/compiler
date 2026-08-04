// ─── Main entry point — multi-file C# test ───────────────────────
// This file uses types from MathHelper.cs and Shapes.cs.
// The WASM runner compiles all .cs files as separate SyntaxTrees
// into one compilation — this tests that multi-file works correctly.

Console.WriteLine("=== MULTI-FILE C# TEST ===");
Console.WriteLine();

// ── 1. MathHelper.cs ──────────────────────────────────────────────
Console.WriteLine("── Math Utilities (from MathHelper.cs) ──");
Console.Write("Fibonacci(0..10): ");
Console.WriteLine(string.Join(", ", Enumerable.Range(0, 11).Select(MathHelper.Fibonacci)));

Console.Write("Factorials(1..8): ");
Console.WriteLine(string.Join(", ", Enumerable.Range(1, 8).Select(i => $"{i}!={MathHelper.Factorial(i)}")));

var primes = MathHelper.Sieve(50);
Console.WriteLine($"Primes ≤ 50 ({primes.Count} total): {string.Join(", ", primes)}");

Console.WriteLine();

// ── 2. Shapes.cs ─────────────────────────────────────────────────
Console.WriteLine("── Geometry (from Shapes.cs) ──");
var shapes = new Shape[]
{
    new Circle(5),
    new Rectangle(4, 6),
    new Triangle(3, 4, 5),
};
foreach (var shape in shapes)
    Console.WriteLine($"  {shape}");

var totalArea = shapes.Sum(s => s.Area);
Console.WriteLine($"  Total area: {totalArea:F2}");

Console.WriteLine();

// ── 3. Advanced: generic sorting across files ──────────────────────
Console.WriteLine("── Cross-file generics ──");
var shapesSortedByArea = shapes.OrderBy(s => s.Area).ToList();
Console.WriteLine("Shapes sorted by area:");
foreach (var s in shapesSortedByArea)
    Console.WriteLine($"  {s.GetType().Name,-12} area={s.Area:F2}");

// ── 4. LINQ + MathHelper combined ─────────────────────────────────
Console.WriteLine();
Console.WriteLine("── LINQ + MathHelper combined ──");
var primeFibs = Enumerable.Range(0, 20)
    .Select(MathHelper.Fibonacci)
    .Where(f => MathHelper.IsPrime(f))
    .Distinct()
    .OrderBy(x => x)
    .ToList();
Console.WriteLine($"Prime Fibonacci numbers (first 20 terms): {string.Join(", ", primeFibs)}");

Console.WriteLine();
Console.WriteLine("=== ALL MULTI-FILE TESTS PASSED ===");

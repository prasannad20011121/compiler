using System.Reflection;
using System.Reflection.Metadata;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

// ─────────────────────────────────────────────────────────────────────────────
//  C# Multi-File Test — mirrors CSharpRunnerInterop.RunCSharp exactly
//  (multiple SyntaxTrees in one CSharpCompilation, same as the WASM runner)
// ─────────────────────────────────────────────────────────────────────────────

Console.OutputEncoding = Encoding.UTF8;
Console.WriteLine("╔══════════════════════════════════════════════════════════════╗");
Console.WriteLine("║       C# Multi-File & Difficulty Tests (Local Harness)      ║");
Console.WriteLine("╚══════════════════════════════════════════════════════════════╝");
Console.WriteLine();

// ── Helper: compile + run multiple files (mirrors Program.cs WASM logic) ─────
async Task<(bool ok, string stdout, string stderr)> RunMultiFile(params (string path, string content)[] files)
{
    var stdoutSb = new StringBuilder();
    var stderrSb  = new StringBuilder();

    try
    {
        var globalUsingsSyntax = CSharpSyntaxTree.ParseText("""
            global using System;
            global using System.Collections.Generic;
            global using System.IO;
            global using System.Linq;
            global using System.Text;
            global using System.Threading;
            global using System.Threading.Tasks;
            """);

        var syntaxTrees = new List<SyntaxTree> { globalUsingsSyntax };
        foreach (var (path, content) in files)
            syntaxTrees.Add(CSharpSyntaxTree.ParseText(content, path: path));

        // Gather references from loaded assemblies
        var references = AppDomain.CurrentDomain.GetAssemblies()
            .Where(a => !a.IsDynamic)
            .Select(ToRef)
            .Where(r => r is not null)
            .Select(r => r!)
            .ToList();

        var compilation = CSharpCompilation.Create("__UserCode__", syntaxTrees, references,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication,
                optimizationLevel: OptimizationLevel.Debug,
                nullableContextOptions: NullableContextOptions.Enable,
                concurrentBuild: false));

        using var peStream = new MemoryStream();
        var emitResult = compilation.Emit(peStream);

        if (!emitResult.Success)
        {
            foreach (var d in emitResult.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error))
                stderrSb.AppendLine(d.ToString());
            return (false, stdoutSb.ToString(), stderrSb.ToString());
        }

        peStream.Seek(0, SeekOrigin.Begin);
        var origOut = Console.Out;
        var origErr = Console.Error;
        Console.SetOut(new StringWriter(stdoutSb));
        Console.SetError(new StringWriter(stderrSb));

        try
        {
            var asm = Assembly.Load(peStream.ToArray());
            var target = FindMain(asm, "<Main>$") ?? FindMain(asm, "Main") ?? asm.EntryPoint
                ?? throw new InvalidOperationException("No entry point.");

            var ps = target.GetParameters();
            var result = ps.Length == 0 ? target.Invoke(null, null) : target.Invoke(null, new object[] { Array.Empty<string>() });
            if (result is Task t) await t;

            Console.Out.Flush();
            Console.Error.Flush();
        }
        finally
        {
            Console.SetOut(origOut);
            Console.SetError(origErr);
        }

        return (true, stdoutSb.ToString(), stderrSb.ToString());
    }
    catch (Exception ex)
    {
        stderrSb.AppendLine($"Runtime error: {ex}");
        return (false, stdoutSb.ToString(), stderrSb.ToString());
    }
}

static MethodInfo? FindMain(Assembly asm, string n)
{
    foreach (var t in asm.GetTypes())
    {
        var m = t.GetMethod(n, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        if (m != null) return m;
    }
    return null;
}

static unsafe MetadataReference? ToRef(Assembly a)
{
    try { if (a.TryGetRawMetadata(out byte* b, out int l)) return AssemblyMetadata.Create(ModuleMetadata.CreateFromMetadata((IntPtr)b, l)).GetReference(); } catch {}
    if (!string.IsNullOrEmpty(a.Location)) try { return MetadataReference.CreateFromFile(a.Location); } catch {}
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST CASES
// ─────────────────────────────────────────────────────────────────────────────

var multiTests = new (string Name, (string path, string content)[] Files, string? ExpectedContains, bool ShouldFail)[]
{
    // ── Multi-file Test A: Two files, shared class ─────────────────────────────
    (
        "Multi-A: Two-file OOP (MathHelper + Program)",
        new[]
        {
            ("MathHelper.cs", """
                public static class MathHelper {
                    public static int Fibonacci(int n) => n <= 1 ? n : Fibonacci(n-1) + Fibonacci(n-2);
                    public static bool IsPrime(int n) {
                        if (n < 2) return false;
                        for (int i = 2; i * i <= n; i++) if (n % i == 0) return false;
                        return true;
                    }
                    public static List<int> Sieve(int limit) {
                        var s = new bool[limit+1]; Array.Fill(s, true); s[0]=s[1]=false;
                        for (int i=2;i*i<=limit;i++) if(s[i]) for(int j=i*i;j<=limit;j+=i) s[j]=false;
                        return Enumerable.Range(2,limit-1).Where(i=>s[i]).ToList();
                    }
                }
                """),
            ("Program.cs", """
                Console.WriteLine("=== Multi-File Test A ===");
                var fibs = Enumerable.Range(0,11).Select(MathHelper.Fibonacci).ToArray();
                Console.WriteLine("Fibonacci: " + string.Join(", ", fibs));
                var primes = MathHelper.Sieve(30);
                Console.WriteLine("Primes ≤ 30: " + string.Join(", ", primes));
                var primeFibs = fibs.Where(MathHelper.IsPrime).Distinct().OrderBy(x=>x);
                Console.WriteLine("Prime Fibs: " + string.Join(", ", primeFibs));
                """),
        },
        "Fibonacci: 0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55",
        false
    ),
    // ── Multi-file Test B: Three files, inheritance hierarchy ──────────────────
    (
        "Multi-B: Three-file shapes hierarchy (abstract + two subclasses)",
        new[]
        {
            ("Shape.cs", """
                public abstract class Shape {
                    public abstract double Area { get; }
                    public abstract double Perimeter { get; }
                    public override string ToString() => $"{GetType().Name}: area={Area:F2}";
                }
                """),
            ("Shapes.cs", """
                public class Circle : Shape {
                    public double R; public Circle(double r){R=r;}
                    public override double Area => Math.PI*R*R;
                    public override double Perimeter => 2*Math.PI*R;
                }
                public class Rectangle : Shape {
                    public double W,H; public Rectangle(double w,double h){W=w;H=h;}
                    public override double Area => W*H;
                    public override double Perimeter => 2*(W+H);
                }
                """),
            ("Program.cs", """
                Console.WriteLine("=== Multi-File Test B ===");
                Shape[] shapes = { new Circle(5), new Rectangle(4,6), new Circle(3) };
                foreach(var s in shapes) Console.WriteLine("  " + s);
                Console.WriteLine($"Total area: {shapes.Sum(s=>s.Area):F2}");
                var biggest = shapes.OrderByDescending(s=>s.Area).First();
                Console.WriteLine($"Biggest: {biggest}");
                """),
        },
        "Total area:",
        false
    ),
    // ── Multi-file Test C: Three files with generics & interfaces ──────────────
    (
        "Multi-C: Three-file generics + interfaces",
        new[]
        {
            ("IRepository.cs", """
                public interface IRepository<T> {
                    void Add(T item);
                    IEnumerable<T> GetAll();
                    T? Find(Func<T,bool> predicate);
                }
                """),
            ("InMemoryRepository.cs", """
                public class InMemoryRepository<T> : IRepository<T> {
                    private readonly List<T> _items = new();
                    public void Add(T item) => _items.Add(item);
                    public IEnumerable<T> GetAll() => _items.AsReadOnly();
                    public T? Find(Func<T,bool> p) => _items.FirstOrDefault(p);
                }
                public record Product(int Id, string Name, decimal Price);
                """),
            ("Program.cs", """
                Console.WriteLine("=== Multi-File Test C ===");
                var repo = new InMemoryRepository<Product>();
                repo.Add(new Product(1, "Laptop", 999.99m));
                repo.Add(new Product(2, "Mouse", 29.99m));
                repo.Add(new Product(3, "Keyboard", 79.99m));
                Console.WriteLine("All products:");
                foreach(var p in repo.GetAll().OrderBy(p=>p.Price))
                    Console.WriteLine($"  [{p.Id}] {p.Name,-12} ${p.Price:F2}");
                var found = repo.Find(p => p.Price > 50);
                Console.WriteLine($"First over $50: {found?.Name}");
                """),
        },
        "All products:",
        false
    ),
    // ── Difficult Test D: Generic permutations (recursive) ────────────────────
    (
        "Difficult-D: Generic permutations + graph DFS",
        new[]
        {
            ("Program.cs", """
                static List<List<T>> Permutations<T>(List<T> items) {
                    if(items.Count==0) return new List<List<T>>{new List<T>()};
                    var result = new List<List<T>>();
                    for(int i=0;i<items.Count;i++) {
                        var rest = items.Where((_,idx)=>idx!=i).ToList();
                        foreach(var perm in Permutations(rest)) {
                            var np = new List<T>{items[i]};
                            np.AddRange(perm); result.Add(np);
                        }
                    }
                    return result;
                }
                Console.WriteLine("=== Difficult Test D ===");
                var perms = Permutations(new List<int>{1,2,3});
                Console.WriteLine($"Permutations of [1,2,3]: {perms.Count}");
                foreach(var p in perms) Console.WriteLine("  ["+string.Join(",",p)+"]");

                // Graph DFS
                var graph = new Dictionary<int,List<int>>{{1,new(){2,3}},{2,new(){4}},{3,new(){4,5}},{4,new()},{5,new()}};
                var visited=new List<int>(); var stack=new Stack<int>(); stack.Push(1);
                while(stack.Count>0){int n=stack.Pop();if(!visited.Contains(n)){visited.Add(n);foreach(var nb in graph[n])stack.Push(nb);}}
                Console.WriteLine("DFS traversal: "+string.Join("->",visited));
                """),
        },
        "Permutations of [1,2,3]: 6",
        false
    ),
    // ── Difficult Test E: async patterns + LINQ complex ───────────────────────
    (
        "Difficult-E: Async + parallel-style processing + advanced LINQ",
        new[]
        {
            ("Program.cs", """
                async Task<int> ComputeAsync(int x) { await Task.Delay(1); return x * x; }
                Console.WriteLine("=== Difficult Test E ===");
                var tasks = Enumerable.Range(1, 5).Select(ComputeAsync).ToList();
                var results = await Task.WhenAll(tasks);
                Console.WriteLine("Squares: " + string.Join(", ", results));

                // Complex LINQ: group, aggregate, flatten
                var data = new[] {
                    (Name:"Alice",   Dept:"Eng",  Score:92),
                    (Name:"Bob",     Dept:"Eng",  Score:85),
                    (Name:"Charlie", Dept:"HR",   Score:78),
                    (Name:"Dave",    Dept:"HR",   Score:91),
                    (Name:"Eve",     Dept:"Eng",  Score:88),
                };
                var grouped = data
                    .GroupBy(x => x.Dept)
                    .Select(g => new { Dept=g.Key, Avg=g.Average(x=>x.Score), Top=g.OrderByDescending(x=>x.Score).First().Name })
                    .OrderBy(g => g.Dept);
                foreach(var g in grouped)
                    Console.WriteLine($"  {g.Dept}: avg={g.Avg:F1}, top={g.Top}");
                Console.WriteLine("Async + LINQ done!");
                """),
        },
        "Squares: 1, 4, 9, 16, 25",
        false
    ),
    // ── Difficult Test F: Compile error on multi-file ─────────────────────────
    (
        "Difficult-F: Multi-file compile error (intentional)",
        new[]
        {
            ("Lib.cs", """
                public class Lib { public static int GoodMethod() => 42; }
                """),
            ("Program.cs", """
                // This should fail: calling a method that doesn't exist
                Console.WriteLine(Lib.GoodMethod());
                Console.WriteLine(Lib.NonExistentMethod());
                """),
        },
        null,
        true  // expects compile failure
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
//  Run all tests
// ─────────────────────────────────────────────────────────────────────────────
int passed = 0, failed = 0;

foreach (var (name, files, expected, shouldFail) in multiTests)
{
    Console.Write($"Running {name}... ");
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var (ok, stdout, stderr) = await RunMultiFile(files);
    sw.Stop();

    bool pass = shouldFail ? !ok : (ok && (expected == null || stdout.Contains(expected)));
    if (pass) passed++; else failed++;

    Console.WriteLine(pass ? $"✅ PASS ({sw.ElapsedMilliseconds}ms)" : $"❌ FAIL ({sw.ElapsedMilliseconds}ms)");

    if (!string.IsNullOrWhiteSpace(stdout))
    {
        foreach (var line in stdout.TrimEnd().Split('\n').Take(15))
            Console.WriteLine($"  │ {line.TrimEnd()}");
    }
    if (!string.IsNullOrWhiteSpace(stderr))
    {
        Console.WriteLine("  │ STDERR:");
        foreach (var line in stderr.TrimEnd().Split('\n').Take(3))
            Console.WriteLine($"  │   {line.TrimEnd()}");
    }
    Console.WriteLine();
}

Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
Console.WriteLine($"MULTI-FILE SUMMARY: {passed} passed / {failed} failed / {multiTests.Length} total");
Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

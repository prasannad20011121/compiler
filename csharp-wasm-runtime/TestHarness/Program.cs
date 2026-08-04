using System.Reflection;
using System.Reflection.Metadata;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

// ─────────────────────────────────────────────────────────────────────────────
//  C# WASM Runtime — Local Test Harness
//  Mirrors the exact Roslyn compile+run logic from Program.cs (browser WASM)
//  so we can verify all test programs without a browser.
// ─────────────────────────────────────────────────────────────────────────────

Console.OutputEncoding = Encoding.UTF8;

// ═══════════════════════════════════════════════════════════════════
// SINGLE-FILE TESTS
// ═══════════════════════════════════════════════════════════════════

var tests = new (string Name, string Source, string? ExpectedContains, bool ShouldFail)[]
{
    (
        "Test 1 – Hello World",
        """
        Console.WriteLine("Hello, World!");
        Console.WriteLine("C# WASM is working!");
        """,
        "Hello, World!",
        false
    ),
    (
        "Test 2 – Variables & Arithmetic",
        """
        int a = 10, b = 25;
        int sum = a + b;
        double avg = (a + b) / 2.0;
        Console.WriteLine($"Sum: {sum}");
        Console.WriteLine($"Average: {avg}");
        Console.WriteLine($"Product: {a * b}");
        """,
        "Sum: 35",
        false
    ),
    (
        "Test 3 – LINQ",
        """
        using System.Linq;
        var numbers = new[] { 3, 1, 4, 1, 5, 9, 2, 6, 5, 3 };
        var distinct = numbers.Distinct().OrderBy(x => x).ToArray();
        Console.WriteLine($"Original count: {numbers.Length}");
        Console.WriteLine($"Distinct sorted: {string.Join(", ", distinct)}");
        Console.WriteLine($"Sum: {numbers.Sum()}");
        Console.WriteLine($"Max: {numbers.Max()}");
        """,
        "Original count: 10",
        false
    ),
    (
        "Test 4 – Classes & OOP (Inheritance + Polymorphism)",
        """
        // Top-level code first, class definitions below (CS8803 rule)
        var animals = new Animal[] { new Dog("Rex"), new Cat("Whiskers"), new Dog("Buddy") };
        foreach (var a in animals)
            Console.WriteLine(a.Speak());

        class Animal {
            public string Name { get; set; } = "";
            public Animal(string name) { Name = name; }
            public virtual string Speak() => $"{Name} says ...";
        }
        class Dog : Animal {
            public Dog(string name) : base(name) {}
            public override string Speak() => $"{Name} says Woof!";
        }
        class Cat : Animal {
            public Cat(string name) : base(name) {}
            public override string Speak() => $"{Name} says Meow!";
        }
        """,
        "Rex says Woof!",
        false
    ),
    (
        "Test 5 – Recursion (Fibonacci)",
        """
        static int Fib(int n) => n <= 1 ? n : Fib(n-1) + Fib(n-2);
        var results = new System.Collections.Generic.List<string>();
        for (int i = 0; i <= 10; i++)
            results.Add(Fib(i).ToString());
        Console.WriteLine(string.Join(", ", results));
        """,
        "0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55",
        false
    ),
    (
        "Test 6 – Exception Handling",
        """
        try {
            int[] arr = {1, 2, 3};
            Console.WriteLine(arr[10]);
        } catch (IndexOutOfRangeException ex) {
            Console.WriteLine($"Caught: {ex.Message}");
        }
        try {
            string? s = null;
            Console.WriteLine(s!.Length);
        } catch (NullReferenceException ex) {
            Console.WriteLine($"Caught NRE: {ex.Message}");
        }
        Console.WriteLine("Exception handling works!");
        """,
        "Exception handling works!",
        false
    ),
    (
        "Test 7 – Compile Error (intentional bad code)",
        """
        int x = "this is not a number";
        Console.WriteLine(x);
        """,
        null,
        true   // expects compile failure
    ),
    (
        "Test 8 – String Manipulation",
        """
        string msg = "Hello, Browser IDE!";
        Console.WriteLine(msg.ToUpper());
        Console.WriteLine(msg.Replace("Hello", "Goodbye"));
        Console.WriteLine($"Length: {msg.Length}");
        Console.WriteLine(string.Join("-", msg.Split(' ')));
        """,
        "HELLO, BROWSER IDE!",
        false
    ),
    (
        "Test 9 – Collections (List, Dictionary)",
        """
        using System.Collections.Generic;
        var scores = new Dictionary<string, int> {
            {"Alice", 95}, {"Bob", 82}, {"Charlie", 91}
        };
        foreach (var kv in scores)
            Console.WriteLine($"{kv.Key}: {kv.Value}");
        var list = new List<int> { 10, 20, 30, 40, 50 };
        list.RemoveAt(2);
        Console.WriteLine(string.Join(", ", list));
        """,
        "Alice: 95",
        false
    ),
    (
        "Test 10 – Async/Await",
        """
        using System.Threading.Tasks;
        async Task<string> FetchData(string name) {
            await Task.Delay(1);
            return $"Data for {name}";
        }
        var result1 = await FetchData("Alice");
        var result2 = await FetchData("Bob");
        Console.WriteLine(result1);
        Console.WriteLine(result2);
        Console.WriteLine("Async completed!");
        """,
        "Data for Alice",
        false
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
//  Roslyn runner (mirrors CSharpRunnerInterop.RunCSharp from Program.cs)
// ─────────────────────────────────────────────────────────────────────────────

async Task<(bool ok, string stdout, string stderr)> RunCSharp(string source)
{
    var stdoutSb = new StringBuilder();
    var stderrSb  = new StringBuilder();

    try
    {
        var syntaxTree = CSharpSyntaxTree.ParseText(source);

    // Global usings preamble — mirrors the fix applied to CSharpRunnerInterop.
    // Gives user code access to Console, List<T>, LINQ, Task etc.
    var globalUsingsSyntax = CSharpSyntaxTree.ParseText("""
        global using System;
        global using System.Collections.Generic;
        global using System.IO;
        global using System.Linq;
        global using System.Text;
        global using System.Threading;
        global using System.Threading.Tasks;
        """);

        var bclAssemblies = new[]
        {
            "System.Runtime", "System.Console", "System.Collections",
            "System.Linq", "System.Linq.Expressions",
            "System.Threading", "System.Threading.Tasks",
            "System.Text.RegularExpressions",
        };
        foreach (var name in bclAssemblies)
            try { Assembly.Load(name); } catch { }

        var references = AppDomain.CurrentDomain
            .GetAssemblies()
            .Where(a => !a.IsDynamic)
            .Select(ToMetadataReference)
            .Where(r => r is not null)
            .Select(r => r!)
            .ToList();

        var compilation = CSharpCompilation.Create(
            "__UserCode__",
            new[] { globalUsingsSyntax, syntaxTree },
            references,
            new CSharpCompilationOptions(
                OutputKind.ConsoleApplication,
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
            var targetMethod =
                FindMain(asm, "<Main>$") ??
                FindMain(asm, "Main") ??
                asm.EntryPoint ??
                throw new InvalidOperationException("No entry point found.");

            var parameters = targetMethod.GetParameters();
            var result = parameters.Length == 0
                ? targetMethod.Invoke(null, null)
                : targetMethod.Invoke(null, new object[] { Array.Empty<string>() });

            if (result is Task task) await task;

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

// ─────────────────────────────────────────────────────────────────────────────
//  Multi-file runner (compiles multiple SyntaxTrees together — same as WASM)
// ─────────────────────────────────────────────────────────────────────────────

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

        var references = AppDomain.CurrentDomain.GetAssemblies()
            .Where(a => !a.IsDynamic).Select(ToMetadataReference)
            .Where(r => r is not null).Select(r => r!).ToList();

        var compilation = CSharpCompilation.Create("__UserMultiFile__", syntaxTrees, references,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication,
                optimizationLevel: OptimizationLevel.Debug,
                nullableContextOptions: NullableContextOptions.Enable, concurrentBuild: false));

        using var peStream = new MemoryStream();
        var emitResult = compilation.Emit(peStream);
        if (!emitResult.Success)
        {
            foreach (var d in emitResult.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error))
                stderrSb.AppendLine(d.ToString());
            return (false, stdoutSb.ToString(), stderrSb.ToString());
        }

        peStream.Seek(0, SeekOrigin.Begin);
        var origOut = Console.Out; var origErr = Console.Error;
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
            Console.Out.Flush(); Console.Error.Flush();
        }
        finally { Console.SetOut(origOut); Console.SetError(origErr); }
        return (true, stdoutSb.ToString(), stderrSb.ToString());
    }
    catch (Exception ex)
    {
        stderrSb.AppendLine($"Runtime error: {ex}");
        return (false, stdoutSb.ToString(), stderrSb.ToString());
    }
}

static MethodInfo? FindMain(Assembly asm, string methodName)
{
    foreach (var type in asm.GetTypes())
    {
        var m = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        if (m != null) return m;
    }
    return null;
}

static unsafe MetadataReference? ToMetadataReference(Assembly assembly)
{
    try
    {
        if (assembly.TryGetRawMetadata(out byte* blob, out int length))
        {
            var moduleMetadata = ModuleMetadata.CreateFromMetadata((IntPtr)blob, length);
            return AssemblyMetadata.Create(moduleMetadata).GetReference();
        }
    }
    catch { /* fall through to Location-based fallback below */ }

    if (!string.IsNullOrEmpty(assembly.Location))
    {
        try { return MetadataReference.CreateFromFile(assembly.Location); }
        catch { /* give up on this assembly */ }
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-FILE TEST CASES
// ═══════════════════════════════════════════════════════════════════

var multiTests = new (string Name, (string path, string content)[] Files, string? ExpectedContains, bool ShouldFail)[]
{
    (
        "Multi-A: Two-file (MathHelper.cs + Program.cs)",
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
                Console.WriteLine("Primes: " + string.Join(", ", primes));
                var primeFibs = fibs.Where(MathHelper.IsPrime).Distinct().OrderBy(x=>x);
                Console.WriteLine("Prime Fibs: " + string.Join(", ", primeFibs));
                """),
        },
        "Fibonacci: 0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55",
        false
    ),
    (
        "Multi-B: Three-file abstract hierarchy (Shape.cs + ShapeImpls.cs + Program.cs)",
        new[]
        {
            ("Shape.cs", """
                public abstract class Shape {
                    public abstract double Area { get; }
                    public abstract double Perimeter { get; }
                    public override string ToString() => $"{GetType().Name}: area={Area:F2}, perim={Perimeter:F2}";
                }
                """),
            ("ShapeImpls.cs", """
                public class Circle : Shape {
                    double R; public Circle(double r){R=r;}
                    public override double Area => Math.PI*R*R;
                    public override double Perimeter => 2*Math.PI*R;
                }
                public class Rectangle : Shape {
                    double W,H; public Rectangle(double w,double h){W=w;H=h;}
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
                Console.WriteLine($"Biggest: {biggest.GetType().Name} area={biggest.Area:F2}");
                """),
        },
        "Total area:",
        false
    ),
    (
        "Multi-C: Three-file generics + interface + records (IRepository.cs + InMemoryRepo.cs + Program.cs)",
        new[]
        {
            ("IRepository.cs", """
                public interface IRepository<T> {
                    void Add(T item);
                    IEnumerable<T> GetAll();
                    T? Find(Func<T,bool> predicate);
                }
                """),
            ("InMemoryRepo.cs", """
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
                repo.Add(new Product(1,"Laptop",999.99m));
                repo.Add(new Product(2,"Mouse",29.99m));
                repo.Add(new Product(3,"Keyboard",79.99m));
                Console.WriteLine("Products sorted by price:");
                foreach(var p in repo.GetAll().OrderBy(p=>p.Price))
                    Console.WriteLine($"  [{p.Id}] {p.Name,-12} ${p.Price:F2}");
                var found = repo.Find(p => p.Price > 50);
                Console.WriteLine($"First over $50: {found?.Name}");
                """),
        },
        "Products sorted by price:",
        false
    ),
    (
        "Difficult-D: Generic permutations + graph DFS",
        new[]
        {
            ("Program.cs", """
                static List<List<T>> Perms<T>(List<T> items) {
                    if(items.Count==0) return new List<List<T>>{new List<T>()};
                    var r = new List<List<T>>();
                    for(int i=0;i<items.Count;i++) {
                        var rest=items.Where((_,idx)=>idx!=i).ToList();
                        foreach(var p in Perms(rest)){var np=new List<T>{items[i]};np.AddRange(p);r.Add(np);}
                    }
                    return r;
                }
                Console.WriteLine("=== Difficult Test D ===");
                var perms=Perms(new List<int>{1,2,3});
                Console.WriteLine($"Permutations of [1,2,3]: {perms.Count}");
                foreach(var p in perms) Console.WriteLine("  ["+string.Join(",",p)+"]");
                var g=new Dictionary<int,List<int>>{{1,new(){2,3}},{2,new(){4}},{3,new(){4,5}},{4,new()},{5,new()}};
                var vis=new List<int>(); var st=new Stack<int>(); st.Push(1);
                while(st.Count>0){int n=st.Pop();if(!vis.Contains(n)){vis.Add(n);foreach(var nb in g[n])st.Push(nb);}}
                Console.WriteLine("DFS: "+string.Join("->",vis));
                """),
        },
        "Permutations of [1,2,3]: 6",
        false
    ),
    (
        "Difficult-E: Async Task.WhenAll + complex LINQ grouping",
        new[]
        {
            ("Program.cs", """
                async Task<int> Sq(int x) { await Task.Delay(1); return x*x; }
                Console.WriteLine("=== Difficult Test E ===");
                var tasks=Enumerable.Range(1,5).Select(Sq).ToList();
                var squares=await Task.WhenAll(tasks);
                Console.WriteLine("Squares: "+string.Join(", ",squares));
                var data=new[]{
                    (Name:"Alice",Dept:"Eng",Score:92),(Name:"Bob",Dept:"Eng",Score:85),
                    (Name:"Charlie",Dept:"HR",Score:78),(Name:"Dave",Dept:"HR",Score:91),
                    (Name:"Eve",Dept:"Eng",Score:88),
                };
                var grouped=data.GroupBy(x=>x.Dept)
                    .Select(g=>new{Dept=g.Key,Avg=g.Average(x=>x.Score),Top=g.OrderByDescending(x=>x.Score).First().Name})
                    .OrderBy(g=>g.Dept);
                foreach(var g in grouped) Console.WriteLine($"  {g.Dept}: avg={g.Avg:F1}, top={g.Top}");
                Console.WriteLine("Async+LINQ done!");
                """),
        },
        "Squares: 1, 4, 9, 16, 25",
        false
    ),
    (
        "Difficult-F: Multi-file compile error detection",
        new[]
        {
            ("Lib.cs", """
                public class Lib { public static int GoodMethod() => 42; }
                """),
            ("Program.cs", """
                Console.WriteLine(Lib.GoodMethod());
                Console.WriteLine(Lib.NonExistentMethod()); // compile error
                """),
        },
        null,
        true  // expects failure
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
//  Run all single-file tests
// ─────────────────────────────────────────────────────────────────────────────

Console.WriteLine("╔══════════════════════════════════════════════════════════════╗");
Console.WriteLine("║          C# WASM Runtime — Test Report                      ║");
Console.WriteLine("╚══════════════════════════════════════════════════════════════╝");
Console.WriteLine();

int passed = 0, failed = 0;
var results = new List<(string name, bool pass, string stdout, string stderr, long ms)>();

foreach (var (name, source, expected, shouldFail) in tests)
{
    Console.Write($"Running {name}... ");
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var (ok, stdout, stderr) = await RunCSharp(source);
    sw.Stop();

    bool pass;
    if (shouldFail)
        pass = !ok;
    else
        pass = ok && (expected == null || stdout.Contains(expected));

    if (pass) passed++; else failed++;
    results.Add((name, pass, stdout, stderr, sw.ElapsedMilliseconds));
    Console.WriteLine(pass ? "✅ PASS" : "❌ FAIL");
}

Console.WriteLine();
Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
Console.WriteLine("DETAILED RESULTS");
Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

foreach (var (name, pass, stdout, stderr, ms) in results)
{
    Console.WriteLine();
    Console.WriteLine($"┌─ {name}  [{(pass ? "PASS" : "FAIL")}]  ({ms}ms)");
    if (!string.IsNullOrWhiteSpace(stdout))
    {
        Console.WriteLine("│  STDOUT:");
        foreach (var line in stdout.TrimEnd().Split('\n'))
            Console.WriteLine($"│    {line.TrimEnd()}");
    }
    if (!string.IsNullOrWhiteSpace(stderr))
    {
        Console.WriteLine("│  STDERR:");
        foreach (var line in stderr.TrimEnd().Split('\n').Take(5))
            Console.WriteLine($"│    {line.TrimEnd()}");
    }
    Console.WriteLine("└─────────────────────────────────────────────────────────────");
}

Console.WriteLine();
Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
Console.WriteLine($"SINGLE-FILE SUMMARY:  {passed} passed  /  {failed} failed  /  {tests.Length} total");
Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

// ─────────────────────────────────────────────────────────────────────────────
//  Run multi-file + difficult tests
// ─────────────────────────────────────────────────────────────────────────────

Console.WriteLine();
Console.WriteLine("╔══════════════════════════════════════════════════════════════╗");
Console.WriteLine("║    MULTI-FILE & DIFFICULT TESTS                              ║");
Console.WriteLine("╚══════════════════════════════════════════════════════════════╝");
Console.WriteLine();

int mpassed = 0, mfailed = 0;

foreach (var (name, files, expected, shouldFail) in multiTests)
{
    Console.Write($"Running {name}... ");
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var (ok, stdout, stderr) = await RunMultiFile(files);
    sw.Stop();

    bool pass = shouldFail ? !ok : (ok && (expected == null || stdout.Contains(expected)));
    if (pass) mpassed++; else mfailed++;
    Console.WriteLine(pass ? $"✅ PASS ({sw.ElapsedMilliseconds}ms)" : $"❌ FAIL ({sw.ElapsedMilliseconds}ms)");

    if (!string.IsNullOrWhiteSpace(stdout))
        foreach (var line in stdout.TrimEnd().Split('\n').Take(12))
            Console.WriteLine($"  │ {line.TrimEnd()}");
    if (!string.IsNullOrWhiteSpace(stderr))
    {
        Console.WriteLine("  │ STDERR:");
        foreach (var line in stderr.TrimEnd().Split('\n').Take(3))
            Console.WriteLine($"  │   {line.TrimEnd()}");
    }
    Console.WriteLine();
}

Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
Console.WriteLine($"MULTI-FILE SUMMARY: {mpassed} passed / {mfailed} failed / {multiTests.Length} total");
Console.WriteLine();
Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
Console.WriteLine($"GRAND TOTAL: {passed + mpassed} passed / {failed + mfailed} failed / {tests.Length + multiTests.Length} total");
Console.WriteLine("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

using System.Net.Http;
using System.Reflection;
using System.Reflection.Metadata;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

// Entry point — required for browser-wasm even if empty
Console.WriteLine("CSharpRunner WASM loaded.");

/// <summary>
/// Exposes C# compile-and-run functionality to JavaScript via JSExport.
/// Called by csharp-worker.js in the browser-IDE.
/// </summary>
public partial class CSharpRunnerInterop
{
    /// <summary>
    /// Compile and execute C# source from one or more files.
    /// <paramref name="filesJson"/> is a JSON array of <c>{"path": string, "content":
    /// string}</c> objects — one per .cs file in the workspace. Each file becomes its
    /// own SyntaxTree, so ordering between files never matters (only the C# rule that
    /// top-level statements must precede type/namespace declarations *within a single
    /// file* still applies). Concatenating all files into one string first — the
    /// simpler alternative — would make that ordering rule depend on which file
    /// happens to sort first, which broke the moment a two-file test put a
    /// declarations-only file (sorted first) ahead of the file with top-level
    /// statements.
    /// <paramref name="baseUrl"/> is the runtime's own AppBundle directory (e.g.
    /// "https://host/runtimes/dotnet-wasm/9.0/") — used to fetch reference assembly
    /// bytes for compiler references (see GatherReferencesAsync).
    /// <paramref name="baseUrlAndFlags"/> is baseUrl, optionally with "#stdin=1"
    /// appended (e.g. from csharp-worker.js: caller has already wired up the
    /// __stdinConfigure/__stdinRequestLine globals with the browser-ide terminal's
    /// stdin SharedArrayBuffer). When present, Console.In gets pointed at
    /// BridgedStdinReader, which blocks on Atomics.wait via those globals.
    /// The flag rides along in this string rather than as a 3rd parameter:
    /// JSExport methods with 3+ parameters were unreliable in this SDK build
    /// (either an immediate "JSObject proxy of X is not supported" marshalling
    /// assert, or the call hanging forever, depending on the 3rd param's type —
    /// reproduced with JSObject, bool, and string alike). Two string parameters
    /// is the proven-reliable shape.
    /// Returns a JSON object: { ok: bool, stdout: string, stderr: string, streamed: bool }.
    /// streamed indicates whether stdout/stderr were already emitted live via
    /// EmitStdout/EmitStderr as the program ran (true for anything that got
    /// past compilation) — the caller should not re-post them in that case, to
    /// avoid duplicating output. Only compile-time diagnostics (produced before
    /// Console is ever redirected) come back with streamed: false.
    /// </summary>
    [JSExport]
    public static async Task<string> RunCSharp(string filesJson, string baseUrlAndFlags)
    {
        var hashIndex = baseUrlAndFlags.IndexOf('#');
        var baseUrl = hashIndex >= 0 ? baseUrlAndFlags[..hashIndex] : baseUrlAndFlags;
        var hasStdin = hashIndex >= 0 && baseUrlAndFlags[hashIndex..].Contains("stdin=1");
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();

        try
        {
            // ── 1. Parse ──────────────────────────────────────────────────────────
            var files = JsonSerializer.Deserialize<List<CsFile>>(filesJson, s_jsonOptions)
                ?? new List<CsFile>();

            // Global usings preamble — mirrors .NET SDK ImplicitUsings so user code
            // can write Console.WriteLine(), List<T>, LINQ etc without explicit usings.
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
            foreach (var file in files)
            {
                syntaxTrees.Add(CSharpSyntaxTree.ParseText(file.Content, path: file.Path));
            }

            // Preload standard BCL assemblies into AppDomain if not already loaded
            var bclAssemblies = new[]
            {
                "System.Runtime",
                "System.Console",
                "System.Collections",
                "System.Linq",
                "System.Linq.Expressions",
                "System.IO.FileSystem",
                "System.Threading",
                "System.Threading.Thread",
                "System.Threading.Tasks",
                "System.Text.RegularExpressions",
                "System.ObjectModel",
                "System.ComponentModel"
            };
            foreach (var name in bclAssemblies)
            {
                try { System.Reflection.Assembly.Load(name); } catch { }
            }

            // ── 2. Resolve references ─────────────────────────────────────────────
            var references = await GatherReferencesAsync(baseUrl);

            // ── 3. Compile ────────────────────────────────────────────────────────
            var compilation = CSharpCompilation.Create(
                assemblyName: "__UserCode__",
                syntaxTrees: syntaxTrees,
                references: references,
                options: new CSharpCompilationOptions(
                    OutputKind.ConsoleApplication,
                    optimizationLevel: OptimizationLevel.Debug,
                    nullableContextOptions: NullableContextOptions.Enable,
                    concurrentBuild: false
                )
            );

            using var peStream = new MemoryStream();
            EmitResult emitResult = compilation.Emit(peStream);

            if (!emitResult.Success)
            {
                foreach (var diag in emitResult.Diagnostics
                    .Where(d => d.Severity == DiagnosticSeverity.Error))
                {
                    stderr.AppendLine(diag.ToString());
                }
                // Never streamed — Console isn't redirected until after a successful
                // compile, so there was nothing to emit live.
                return BuildResult(false, stdout.ToString(), stderr.ToString(), streamed: false);
            }

            // ── 4. Execute ────────────────────────────────────────────────────────
            peStream.Seek(0, SeekOrigin.Begin);

            // Redirect Console so we capture output. Note: we deliberately never read
            // Console.In here to save/restore an "original" value — on browser-wasm,
            // merely *reading* Console.In lazily initializes the default reader via
            // ConsolePal.GetOrCreateReader(), which itself throws
            // PlatformNotSupportedException (there is no OS stdin to back it). Only
            // ever write to Console.In (via SetIn), never read the getter.
            var origOut = Console.Out;
            var origErr = Console.Error;
            Console.SetOut(new StreamingWriter(stdout, isError: false));
            Console.SetError(new StreamingWriter(stderr, isError: true));

            if (hasStdin)
            {
                Console.SetIn(new BridgedStdinReader());
            }

            try
            {
                var asm = System.Reflection.Assembly.Load(peStream.ToArray());
                
                // Find the Main method directly and invoke+await it ourselves, rather than
                // going through Assembly.EntryPoint. For an async top-level-statements
                // program (or an explicit `static async Task Main`), EntryPoint resolves to
                // a compiler-synthesized native entry stub that does
                // `<Main>$(args).GetAwaiter().GetResult()` — a *synchronous* block — which
                // throws PlatformNotSupportedException ("Cannot wait on monitors on this
                // runtime") since single-threaded browser-wasm has no real thread to block.
                // Invoking the actual Main method (named "Main" for an explicit Program
                // class, or "<Main>$" for top-level statements) from inside our own already-
                // async RunCSharp and `await`-ing its Task avoids that synchronous bridge
                // entirely.
                var targetMethod =
                    FindMain(asm, "<Main>$") ??
                    FindMain(asm, "Main") ??
                    asm.EntryPoint ??
                    throw new InvalidOperationException("No entry point found in compiled assembly.");

                var parameters = targetMethod.GetParameters();
                object? result = parameters.Length == 0
                    ? targetMethod.Invoke(null, null)
                    : targetMethod.Invoke(null, new object[] { Array.Empty<string>() });

                if (result is Task task)
                {
                    await task;
                }

                // Flush any buffered output
                Console.Out.Flush();
                Console.Error.Flush();
            }
            finally
            {
                Console.SetOut(origOut);
                Console.SetError(origErr);
                // Console.In is deliberately left as-is (see note above) — there's no
                // real "original" to restore to on this platform, and the worker is
                // kept warm across runs using the same long-lived stdinSab anyway.
            }

            return BuildResult(true, stdout.ToString(), stderr.ToString(), streamed: true);
        }
        catch (Exception ex)
        {
            // Emit directly (not through Console.Error, which may already have been
            // restored to origErr by the finally block above by the time we get
            // here) so this message reaches the terminal live like everything else,
            // regardless of whether the exception happened before or after
            // compilation. That's what makes streamed: true correct in every case —
            // there's nothing left in stdout/stderr that wasn't already emitted.
            var message = $"Runtime error: {ex}";
            stderr.AppendLine(message);
            EmitStderr(message + "\n");
            return BuildResult(false, stdout.ToString(), stderr.ToString(), streamed: true);
        }
    }

    // ── stdin bridge ─────────────────────────────────────────────────────────────
    // __stdinRequestLine is installed on the worker's global scope by
    // csharp-worker.js (self.__stdinRequestLine = ...) before RunCSharp is
    // called. Calling it blocks this worker thread (Atomics.wait) until the
    // main thread delivers a line typed into the terminal — same protocol
    // cpp-worker.js uses. Referencing it via "globalThis.__stdinRequestLine"
    // needs no JSHost.ImportAsync/module registration — plain global lookup.
    [JSImport("globalThis.__stdinRequestLine")]
    private static partial string RequestStdinLine();

    /// <summary>
    /// Routes Console.ReadLine() to the JS-side stdin bridge. Only ReadLine() is
    /// implemented — Console.Read()/ReadKey() aren't wired up (user programs almost
    /// always use ReadLine() for console input; falls back to TextReader's default
    /// EOF behavior otherwise rather than hanging).
    /// </summary>
    private sealed class BridgedStdinReader : TextReader
    {
        public override string? ReadLine() => RequestStdinLine();
    }

    // ── stdout/stderr streaming ─────────────────────────────────────────────────
    // Emit each Write/WriteLine to JS immediately instead of only returning
    // accumulated output once RunCSharp's Task completes. Without this, a long-
    // running or infinite-looping program shows literally nothing — not even
    // output that already printed — until it finishes or the user hits Stop.

    [JSImport("globalThis.__stdoutWrite")]
    private static partial void EmitStdout(string text);

    [JSImport("globalThis.__stderrWrite")]
    private static partial void EmitStderr(string text);

    /// <summary>
    /// Still accumulates into the same StringBuilder BuildResult uses (so the
    /// final JSON result is unchanged for consumers that want the full text),
    /// but also emits every write live via EmitStdout/EmitStderr. Only
    /// Write(char)/Write(char[])/Write(string)/WriteLine()/WriteLine(string) are
    /// overridden — TextWriter's base implementations for every other overload
    /// (Write(int), WriteLine(object), etc.) funnel through Write(string)/
    /// WriteLine(string) already, so those don't need separate overrides.
    /// </summary>
    private sealed class StreamingWriter : TextWriter
    {
        private readonly StringBuilder _buffer;
        private readonly bool _isError;

        public StreamingWriter(StringBuilder buffer, bool isError)
        {
            _buffer = buffer;
            _isError = isError;
        }

        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(char value) => Emit(value.ToString());

        public override void Write(char[]? buffer, int index, int count)
        {
            if (buffer == null || count == 0) return;
            Emit(new string(buffer, index, count));
        }

        public override void Write(string? value)
        {
            if (string.IsNullOrEmpty(value)) return;
            Emit(value);
        }

        public override void WriteLine() => Emit("\n");

        public override void WriteLine(string? value) => Emit((value ?? string.Empty) + "\n");

        private void Emit(string text)
        {
            _buffer.Append(text);
            if (_isError) EmitStderr(text); else EmitStdout(text);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────

    private sealed record CsFile(
        [property: JsonPropertyName("path")] string Path,
        [property: JsonPropertyName("content")] string Content);

    private static readonly JsonSerializerOptions s_jsonOptions =
        new(JsonSerializerDefaults.Web);

    private static MethodInfo? FindMain(Assembly asm, string methodName)
    {
        foreach (var type in asm.GetTypes())
        {
            var m = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (m != null) return m;
        }
        return null;
    }

    private static readonly HttpClient s_httpClient = new();

    /// <summary>
    /// Builds Roslyn MetadataReferences for every loaded, non-dynamic assembly.
    /// Strategies are tried in order, cheapest first:
    ///   1. Assembly.Location / Assembly.TryGetRawMetadata (works on desktop .NET;
    ///      both are no-ops on Mono's browser-wasm runtime, where Location is always
    ///      empty and TryGetRawMetadata always returns false).
    ///   2. HTTP fetch of the assembly's own file from the runtime's AppBundle
    ///      directory — every assembly is already served there same-origin (it's how
    ///      dotnet.js loaded it in the first place). This is the one strategy that
    ///      reliably works on browser-wasm, and costs no extra network round trips
    ///      beyond what the runtime already paid for, since the browser HTTP cache
    ///      serves the bytes back. Requires WasmEnableWebcil=false (CSharpRunner.csproj)
    ///      so these are plain PE .dll bytes — the SDK's default WebCIL wrapper format
    ///      isn't something MetadataReference.CreateFromImage can parse.
    /// Without this, every compilation fails with CS0518 "Predefined type 'System.Object'
    /// is not defined" because Roslyn has zero usable references for the BCL.
    /// </summary>
    private static async Task<List<MetadataReference>> GatherReferencesAsync(string baseUrl)
    {
        var references = new List<MetadataReference>();

        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (assembly.IsDynamic) continue;

            var reference = ToMetadataReferenceFromMemory(assembly);

            if (reference is null)
            {
                var name = assembly.GetName().Name;
                if (!string.IsNullOrEmpty(name))
                {
                    try
                    {
                        var bytes = await s_httpClient.GetByteArrayAsync($"{baseUrl}{name}.dll");
                        reference = MetadataReference.CreateFromImage(bytes);
                    }
                    catch { /* no file for this assembly (e.g. a facade) — skip it */ }
                }
            }

            if (reference is not null) references.Add(reference);
        }

        return references;
    }

    private static unsafe MetadataReference? ToMetadataReferenceFromMemory(Assembly assembly)
    {
        if (!string.IsNullOrEmpty(assembly.Location))
        {
            try { return MetadataReference.CreateFromFile(assembly.Location); }
            catch { /* fall through */ }
        }

        try
        {
            if (assembly.TryGetRawMetadata(out byte* blob, out int length))
            {
                var moduleMetadata = ModuleMetadata.CreateFromMetadata((IntPtr)blob, length);
                return AssemblyMetadata.Create(moduleMetadata).GetReference();
            }
        }
        catch { /* fall through */ }

        return null;
    }

    private static string BuildResult(bool ok, string stdout, string stderr, bool streamed)
    {
        // Hand-build JSON to avoid pulling in System.Text.Json trimming complications
        return $"{{\"ok\":{(ok ? "true" : "false")},\"stdout\":{EscapeJson(stdout)},\"stderr\":{EscapeJson(stderr)},\"streamed\":{(streamed ? "true" : "false")}}}";
    }

    private static string EscapeJson(string s)
    {
        var sb = new StringBuilder();
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                        sb.Append($"\\u{(int)c:x4}");
                    else
                        sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}

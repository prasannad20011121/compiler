# C# WASM Runtime — Build & Share Guide

This subfolder contains everything needed to build the **C# (.NET 9 WASM + Roslyn)** runtime
for the browser-IDE and copy the output to another machine.

```
csharp-wasm-runtime/
├── build.ps1              ← Run this to build the AppBundle
├── BUILD.md               ← This file
└── CSharpRunner/
    ├── CSharpRunner.csproj
    ├── Program.cs          ← Roslyn compile-and-execute logic + JSExport API
    ├── main.mjs            ← dotnet.js bootstrap hook
    └── TrimmerRoots.xml    ← Prevents IL trimmer from removing Roslyn
```

After a successful build the output lands in:
```
client/public/runtimes/dotnet-wasm/9.0/
```

---

## Prerequisites

### 1. Install .NET SDK 9.0+

**Option A — Installer (recommended, requires admin):**
Download from https://dotnet.microsoft.com/download and run the `.exe`.

**Option B — No-admin PowerShell install:**
```powershell
# Downloads dotnet to your user profile — no admin required
Invoke-WebRequest -Uri "https://dot.net/v1/dotnet-install.ps1" -OutFile "$env:TEMP\dotnet-install.ps1"
& "$env:TEMP\dotnet-install.ps1" -Channel 9.0 -InstallDir "$env:LOCALAPPDATA\Microsoft\dotnet"

# Add to PATH for this session
$env:PATH = "$env:LOCALAPPDATA\Microsoft\dotnet;$env:PATH"
$env:DOTNET_ROOT = "$env:LOCALAPPDATA\Microsoft\dotnet"
```

Verify: `dotnet --version` should print `9.x.x`.

### 2. Install the wasm-tools workload

```powershell
dotnet workload install wasm-tools
```

This is a one-time step (~500 MB download). It installs the WASM-specific SDK targets.

---

## Building

Run the build script from the `csharp-wasm-runtime/` directory:

```powershell
cd csharp-wasm-runtime
.\build.ps1
```

The script will:
1. Verify `dotnet` and `wasm-tools` are installed
2. Restore NuGet packages (Roslyn ~30 MB, first time)
3. Publish the `browser-wasm` AppBundle
4. Write output to `../client/public/runtimes/dotnet-wasm/9.0/`
5. Print a file-size summary

Expected output files in `client/public/runtimes/dotnet-wasm/9.0/`:
```
dotnet.js                   ~  50 KB   (runtime bootstrap loader)
dotnet.native.wasm          ~  8 MB    (the .NET CLR compiled to WASM)
dotnet.runtime.js           ~ 150 KB   (JS/WASM bridge)
dotnet.boot.js              ~  30 KB   (manifest + config)
CSharpRunner.wasm           ~  2 MB    (our app + Roslyn compiler)
*.dll (managed assemblies)  variable
.complete                   (stamp file — written by build.ps1)
```

Total size is typically **15–25 MB** compressed.

---

## Sharing with Another Laptop

After building, **copy this entire folder** to the target machine:

```
client/public/runtimes/dotnet-wasm/
```

The target machine does **not** need the .NET SDK — only a browser.

### Steps on target machine

1. Copy `client/public/runtimes/dotnet-wasm/` into the same location in the project.
2. No `npm run runtimes` step needed — the files are already in place.
3. Serve the IDE normally (`npm start` in `client/`).
4. Open a `.cs` file and press **Run**.

> **Note:** The `download-runtimes.mjs` script (`npm run runtimes`) recognises the
> `"source": "local"` entry in `runtimes.json` and simply verifies the folder exists
> without trying to re-download anything.

---

## Monaco Syntax Highlighting for .cs

Monaco Editor has built-in C# language support. The IDE automatically detects `.cs`
files and applies C# syntax highlighting — no extra configuration needed.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `'dotnet' is not recognized` | Add the SDK install directory to your PATH (see Prerequisites) |
| `NETSDK1045: The current .NET SDK does not support targeting .NET 9` | Install .NET SDK 9.0+ |
| `Workload 'wasm-tools' not installed` | `dotnet workload install wasm-tools` |
| Build succeeds but runtime doesn't load in browser | Check browser console — ensure the server sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers (already set in `client/public/_headers`) |
| `CSharpRunnerInterop` not found at runtime | Rebuild — TrimmerRoots.xml preserves the type, but a stale build may be cached |

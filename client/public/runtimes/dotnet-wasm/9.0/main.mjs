// main.mjs — JavaScript entry point for the browser-wasm AppBundle.
// The .NET runtime calls this after it boots; we don't need to do anything
// here beyond letting the runtime initialize (Program.cs console output
// confirms load). The actual entry point is exposed via JSExport.

export function onRuntimeReady() {
  // Called by dotnet.js when the runtime is fully initialized.
  // The IDE worker talks to us via the exported RunCSharp() function;
  // this hook is just a lifecycle no-op.
}

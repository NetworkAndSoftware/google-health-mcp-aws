// Bundles src/lambda.ts into a single file for template.yaml's CodeUri, so the deployment
// needs no node_modules.
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist-lambda", { recursive: true, force: true });

await build({
  entryPoints: ["src/lambda.ts"],
  outfile: "dist-lambda/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Provided by the Lambda Node.js runtime
  external: ["@aws-sdk/*"],
  sourcemap: true,
  // Bundled CommonJS dependencies (express etc.) call require() for Node built-ins
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});

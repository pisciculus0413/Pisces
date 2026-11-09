import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [caseName, packageRoot] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (caseName === undefined || packageRoot === undefined) {
  fail("usage: extensions-loader-child.mjs <hosts|json|semantics|formats> <packageRoot>");
}

const { createExtensionLoader } = await import(
  new URL("../../dist/extensions/loader.js", import.meta.url)
);
const core = await import(new URL("../../../core/dist/index.js", import.meta.url));
const protocol = await import(new URL("../../../protocol/dist/index.js", import.meta.url));
const daemon = await import(new URL("../../dist/index.js", import.meta.url));

const entryPath = join(packageRoot, "entry.ts");

async function loadPath(path) {
  const bytes = readFileSync(path);
  const entryDigest = createHash("sha256").update(bytes).digest("hex");
  return createExtensionLoader().load({
    info: { type: "tool", source: "dist", name: "dist#tool" },
    packageRoot,
    entryPath: path,
    entryDigest,
  });
}

function assert(condition, message) {
  if (!condition) fail(message);
}

try {
  const module = await loadPath(entryPath);
  let result;
  switch (caseName) {
    case "hosts": {
      const value = await module.default();
      assert(value.core === core.ToolDeniedError, "core export identity");
      assert(value.protocol === protocol.encodeFrame, "protocol export identity");
      assert(value.daemon === daemon.bootstrapGateway, "daemon export identity");
      assert(value.dynamicProtocol === protocol.encodeFrame, "dynamic protocol identity");
      assert(value.requiredCore === core.ToolDeniedError, "computed core identity");
      assert(value.error instanceof core.ToolDeniedError, "error instance identity");
      result = { core: true, protocol: true, daemon: true, error: true };
      break;
    }
    case "json": {
      const expected = JSON.parse(readFileSync(join(packageRoot, "expected.json"), "utf8"));
      const values = module.default();
      assert(Array.isArray(values), "json values array");
      assert(values.length === expected.length, "json value count");
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        assert(value.esm === value.cjs, `json default identity ${index}`);
        assert(value.again === value.cjs, `json repeat identity ${index}`);
        assert(
          JSON.stringify(value.cjs) === JSON.stringify(expected[index]),
          `json value ${index}`,
        );
        if (typeof expected[index] === "object" && expected[index] !== null) {
          assert(
            JSON.stringify(Reflect.ownKeys(value.cjs)) ===
              JSON.stringify(Reflect.ownKeys(expected[index])),
            `json own keys ${index}`,
          );
        }
      }
      result = { count: values.length };
      break;
    }
    case "semantics": {
      const value = await module.default();
      const metaPath = join(packageRoot, "deps", "meta.cjs");
      assert(value.filename === metaPath, "dependency filename");
      assert(value.dirname === join(packageRoot, "deps"), "dependency dirname");
      assert(
        value.metaURL === pathToFileURL(join(packageRoot, "deps", "meta.mjs")).href,
        "dependency import.meta.url",
      );
      assert(value.tla === 17, "TLA value");
      assert(value.computed === 19, "computed relative import");
      result = { filename: true, metaURL: true, tla: 17, computed: 19 };
      break;
    }
    case "formats": {
      fail("formats entry unexpectedly loaded");
      break;
    }
    default:
      fail(`unknown case: ${caseName}`);
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  if (caseName === "formats") {
    try {
      assert(error?.name === "ExtensionLoadError", `formats error name ${String(error?.name)}`);
      assert(
        error?.message === "Unsupported extension module format",
        `formats error message ${String(error?.message)}`,
      );
      const control = await loadPath(join(packageRoot, "control.ts"));
      assert(control.default() === "control", "formats control");
      process.stdout.write(JSON.stringify({ rejected: true, control: true }));
      process.exit(0);
    } catch (controlError) {
      fail(`formats assertion failed: ${String(controlError)}`);
    }
  }
  fail(error?.stack ?? String(error));
}

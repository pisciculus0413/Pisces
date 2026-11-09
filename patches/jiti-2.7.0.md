# Pisces local patch for jiti 2.7.0

Upstream: `jiti@2.7.0` (MIT, unjs/jiti), exact dependency of `@pisces/daemon`.
Registered with pnpm 12.8.1 as `patchedDependencies: jiti@2.7.0` in
`pnpm-workspace.yaml`; the lockfile records the patch hash. Only
`dist/jiti.cjs` (runtime), `dist/babel.cjs` (bundled transformer) and
`lib/types.d.ts` (private types) differ. The MIT
`LICENSE` is unchanged. No other dependency is upgraded.

Patch file SHA-256: `128e860385ec4366a7945e5ca6b241357f652a920be95ab13af25bd1e2a794a1`

## Hashes

| file | upstream SHA-256 | patched SHA-256 |
|---|---|---|
| `dist/jiti.cjs` | `a0b3b8d5e06a0519c66b62179e29200533057920f6f11370546e979dacd24c49` | `d3001a26ddd23027ed73ef02ed438544aafbfeb2fa81c707e43f61f96ea74b96` |
| `lib/types.d.ts` | `90d87e4d7f5af338fcb1004ae9de9d54d08c04e93df1c2fd655d426ee1238429` | `40540853a7b9236d5167854852e5d18299fa6b47ed4d29437a0b4c15874dc49b` |
| `dist/babel.cjs` | `b3bc89a8dc40860fb6a7a78512bdfe5976c6253e6ded74b7d96ece803cac8701` | `22cf9f671430e97c5bedf2ecb6e7af844a6ddff75148de10613c9e931ad3ca59` |
| `LICENSE` | `46231df5a7733c3f52f11b71f3df61813007745b62b09031acfb45fb42d75082` | same (unmodified) |

The upstream hash is the installed 2.7.0 artifact recorded before the patch
(also in the loader-selection spike's `PATCH.md`). The generated patch is a
single-line diff for the bundle; the readable anchors below are the review
material.

## Runtime changes

All runtime changes are gated by the private instance option
`transformAll === true`. Omitted/false keeps upstream behavior. The option is
not public upstream API.

### 1. Private helpers before `jitiRequire`

Old anchor:

```js
function jitiRequire(e,t,i){const n=e.parentCache||{};
```

New anchor:

```js
const piscesExtensionScriptExtensions=new Set([".js",".mjs",".cjs",".jsx",".ts",".mts",".cts",".tsx"]);
const piscesExtensionJsonCache=Symbol("pisces.extension.jsonCache");
function piscesExtensionError(code,message){...}
function piscesExtensionFormatError(){return piscesExtensionError("ERR_PISCES_EXTENSION_FORMAT","Unsupported extension module format")}
function jitiRequire(e,t,i){const n=e.parentCache||{};
```

### 2. Graph-private raw JSON cache and async namespace

Old anchor:

```js
if(".json"===c){debug(e,"[json]",a);const t=e.nativeRequire(a);
return t&&!("default"in t)&&Object.defineProperty(t,"default",{value:t,enumerable:!1}),t}
```

New anchor:

```js
if(".json"===c){if(debug(e,"[json]",a),e.opts.transformAll===!0){
  const t=n[piscesExtensionJsonCache]||(n[piscesExtensionJsonCache]=Object.create(null));
  if(!(a in t)){const s=readFileSync(a,"utf8");try{t[a]=JSON.parse(s)}
    catch{throw piscesExtensionError("ERR_PISCES_EXTENSION_JSON","Extension module JSON is invalid")}}
  const s=t[a];if(!i.async&&!i.piscesNamespace)return s;
  const o=Object.create(null);
  if("object"==typeof s&&null!==s)for(const e of Object.keys(s))"default"!==e&&(o[e]=s[e]);
  return o.default=s,o}
  const t=e.nativeRequire(a);return t&&!("default"in t)&&Object.defineProperty(t,"default",...),t}
```

`n` is the evaluation graph's `parentCache`. The cache is not `require.cache`
and is not shared across roots. CJS `require` gets the raw `JSON.parse` value.
Async ESM import gets a separate namespace object whose `default` is that same
raw value; the raw object is never decorated and primitives are never used as
property targets.

### 3. Format rejection and native fallback

Old anchor:

```js
if(c&&!e.opts.extensions.includes(c))return debug(e,"[native]","[unknown]",...),nativeImportOrRequire(e,a,i.async);
if(e.isNativeRe.test(a))return debug(e,"[native]",...),nativeImportOrRequire(e,a,i.async);
```

New anchor:

```js
if(e.opts.transformAll===!0&&!piscesExtensionScriptExtensions.has(c))throw piscesExtensionFormatError();
if(c&&!e.opts.extensions.includes(c))return debug(...),nativeImportOrRequire(e,a,i.async);
if(e.opts.transformAll!==!0&&e.isNativeRe.test(a))return debug(...),nativeImportOrRequire(e,a,i.async);
```

The check runs after virtual modules/builtins and resolution but before any
native require/import branch. Actual suffixless files, `.wasm`, `.node`, `.txt`
and other unsupported formats therefore fail before Node can load them. In
extension mode, `isNativeRe` (which always contains `typescript`/`jiti` plus
`nativeModules`) no longer forces native CJS for supported scripts. Bare and
`node:` builtins are handled earlier and still pass through.

### 4. Evaluation mode conflict and format check

Old anchor:

```js
C=".cjs"===l,S=n.forceTranspile??(!C&&!(w&&n.async)&&(E||w||t.isTransformRe.test(c)||hasESMSyntax(i))),I=Ci.performance.now();if(S){
```

New anchor:

```js
C=".cjs"===l;
if(t.opts.transformAll===!0){
  if(!1===n.forceTranspile)throw piscesExtensionError("ERR_PISCES_EXTENSION_MODE","Conflicting forceTranspile option");
  if(!piscesExtensionScriptExtensions.has(l))throw piscesExtensionFormatError()}
const S=n.forceTranspile??(t.opts.transformAll===!0?!0:(!C&&!(w&&n.async)&&(E||w||t.isTransformRe.test(c)||hasESMSyntax(i)))),I=Ci.performance.now();if(S){
```

This covers `evalModule` entry evaluation, including an entry filename ending
in `.json`, before jiti's native evaluation fallback. `transformAll` makes
nested JS/CJS dependencies transpile even when upstream would choose native.

### 5. Read-only instance marker

Old anchor:

```js
return j}})(),module.exports=i.default})();
```

New anchor:

```js
if(a.transformAll===!0)Object.defineProperty(j,"piscesExtensionModeVersion",{value:1,writable:!1,enumerable:!1,configurable:!1});
return j}})(),module.exports=i.default})();
```

The adapter checks the exact value before evaluating entry bytes. An upstream
or wrongly patched install therefore fails closed instead of silently
restoring native CJS loading.

## Type changes (`lib/types.d.ts`)

- `Jiti`: optional `readonly piscesExtensionModeVersion?: 1`.
- `JitiOptions`: optional `transformAll?: boolean`.

Both are documented as Pisces-private and not upstream jiti 2.7.0 API.

## Upgrade / regeneration

Do not edit installed packages. Regenerate through pnpm:

```bash
pnpm patch jiti@<version> --edit-dir <temporary-copy>
# edit the necessary runtime/transformer and private types only
pnpm patch-commit <temporary-copy>
```

Then re-diff upstream control flow, update the readable anchors and all hashes,
run the engine/adapter loader matrix on Node 22.19/24/26, the install verifier
and full gate G. A patch that needs a new module system or global loader/cache
hooks is out of scope; stop instead of falling back to unpatched jiti.

## Correction: compiler-derived synchronous namespace edge

A product async entry can use ordinary require to reach a TS module transpiled
synchronously. Static ESM imports must remain distinct from ordinary require.
No raw JSON decoration or generic `__esModule` heuristic is used.

Runtime anchors (in addition to the updated anchors above):

- `transform` old `interopDefault:e.opts.interopDefault,...t});` becomes
  `interopDefault:e.opts.interopDefault,...t,piscesExtensionMode:e.opts.transformAll===!0});`.
- JSON raw return old `if(!i.async)return s;` becomes
  `if(!i.async&&!i.piscesNamespace)return s;`. Both namespace edges share the
  existing separate namespace construction; raw graph cache stays untouched.
- Before the marker: enabled instances alone define a private non-enumerable
  `piscesImport` function on their require object:
  `Object.defineProperty(j,"piscesImport",{value:id=>jitiRequire(O,id,{async:!1,piscesNamespace:!0})})`.
  Other module types retain the original return semantics.

Bundled transformer `dist/babel.cjs` anchors:

- Plugin options old `async:h=!1}=r,m=` becomes
  `async:h=!1,piscesExtensionMode:piscesMode=!1}=r,m=`.
- Static source import sync callee old `e.types.identifier("require")` becomes
  `piscesMode?e.types.memberExpression(e.types.identifier("require"),e.types.identifier("piscesImport")):e.types.identifier("require")`.
  Only compiler-derived static import edges change; ordinary source requires do not.
- Transform plugin options old `noInterop:!r.interopDefault,async:r.async` gains
  `piscesExtensionMode:r.piscesExtensionMode===!0`.

Absent/false mode selects the original Babel callee and upstream evaluation
heuristic. Enabled mode alone selects the namespace edge, including objects
whose legitimate JSON keys are `__esModule` and/or `default`.

Generated patch files carry vendored upstream whitespace verbatim (this patch
includes an upstream `dist/babel.cjs` line that is a single space, so
`git diff --check` reports it at default diff context). Per the controller
whitespace ruling, the repo `.gitattributes` scopes the whitespace-error
exception to `patches/*.patch` only; authored source and tests keep full
whitespace checking. Do not hand-edit the patched bytes to silence it.

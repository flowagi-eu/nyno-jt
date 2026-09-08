import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const PROJECT_ROOT = process.env.JT_SCRIPT_DIR;
const SOURCE_MAP_ROOT = resolve(PROJECT_ROOT, ".source-map");
import { sep } from "node:path";

const NODE_MODULES = `${sep}node_modules${sep}`;

/*
 * ---------------------------------------------------------------------------
 * Node ESM loader
 * ---------------------------------------------------------------------------
 */

export async function load(url, context, nextLoad) {
if (!url.startsWith("file:")) {
    return nextLoad(url, context);
  }

  const filename = fileURLToPath(url);

  if (filename.includes(NODE_MODULES)) {
    return nextLoad(url, context);
  }


  // only allow certain extensions for security
  if (!/\.(ts|jt|tsx)$/.test(filename)) {
    return nextLoad(url, context);
  }

  let source = await readFile(filename, "utf8");

  /*
   * Remove @CheckAtRuntime and inject runtime checks before
   * handing the source to esbuild.
   */
  source = preprocess(source);

  const result = await transform(source, {
    loader: filename.endsWith(".tsx") ? "tsx" : "ts",

    format: "esm",
    platform: "node",
    target: "node24",

    /*
     * Generate an external source map.
     *
     * result.map is the JSON source-map contents.
     * result.code contains the generated JavaScript.
     */
    sourcemap: "external",

    /*
     * Keep the original source available inside the source map.
     */
    sourcefile: filename,
    sourcesContent: true,
  });

  /*
   * -------------------------------------------------------------------------
   * Asynchronously write source map
   * -------------------------------------------------------------------------
   *
   * Example:
   *
   *   /project/src/foo.ts
   *
   * becomes:
   *
   *   /project/.source-map/src/foo.ts.map
   *
   * And:
   *
   *   /project/src/utils/foo.ts
   *
   * becomes:
   *
   *   /project/.source-map/src/utils/foo.ts.map
   */

  const relativePath = relative(PROJECT_ROOT, filename);

  const mapPath = resolve(
    SOURCE_MAP_ROOT,
    `${relativePath}.map`,
  );

  /*
   * Fire and forget.
   *
   * The module does NOT wait for the source map to be written.
   */
  void (async () => {
    try {
      await mkdir(dirname(mapPath), {
        recursive: true,
      });

      await writeFile(mapPath, result.map, "utf8");
    } catch (error) {
      console.error(
        `tsrun: failed to write source map: ${mapPath}`,
      );

      console.error(error);
    }
  })();

  return {
    format: "module",
    source: result.code,
    shortCircuit: true,
  };
}


/*
 * ---------------------------------------------------------------------------
 * @CheckAtRuntime preprocessing
 * ---------------------------------------------------------------------------
 *
 * Converts:
 *
 *   @CheckAtRuntime
 *   function fn(user: User, name: string) {
 *     ...
 *   }
 *
 * into approximately:
 *
 *   function fn(user, name) {
 *     if (!(user instanceof User)) {
 *       throw new TypeError("user must be User");
 *     }
 *
 *     if (typeof name !== "string") {
 *       throw new TypeError("name must be string");
 *     }
 *
 *     ...
 *   }
 *
 * This is intentionally a small lexical parser.
 * esbuild still handles all normal TypeScript syntax/transpilation.
 */

function preprocess(source) {
  let output = "";

  /*
   * `cursor` is always an index into the ORIGINAL source.
   *
   * This is important. We cannot use output.length because previous
   * decorators/checks may have changed the output length.
   */
  let cursor = 0;
  let scan = 0;

  while (scan < source.length) {
    const decoratorStart = findCheckAtRuntime(source, scan);

    if (decoratorStart === -1) {
      break;
    }

    const fn = findDecoratedFunction(
      source,
      decoratorStart,
    );

    if (!fn) {
      /*
       * Not something we understand. Continue searching.
       */
      scan = decoratorStart + "@CheckAtRuntime".length;
      continue;
    }

    /*
     * Preserve everything between the previous transformation
     * and this decorator.
     */
    output += source.slice(cursor, decoratorStart);

    /*
     * Preserve the function declaration itself, but remove the
     * TypeScript parameter annotations.
     */
    const functionSource = source.slice(
      fn.functionStart,
      fn.bodyStart,
    );

    const rewrittenFunction = removeParameterTypes(
      functionSource,
      fn.paramsStart,
      fn.paramsEnd,
    );

    /*
     * The functionSource begins at fn.functionStart.
     *
     * Insert runtime checks immediately after `{`.
     */
    output += rewrittenFunction;

    output += "{\n";

    for (const param of fn.params) {
      const check = runtimeCheckForParameter(param);

      if (check) {
        output += `  ${check}\n`;
      }
    }

    /*
     * Preserve the original function body after `{`.
     *
     * fn.bodyStart points at `{`.
     */
    output += source.slice(
      fn.bodyStart + 1,
      fn.bodyStart + 1,
    );

    /*
     * Move past the opening `{`.
     */
    cursor = fn.bodyStart + 1;
    scan = cursor;
  }

  output += source.slice(cursor);

  return output;
}


/*
 * ---------------------------------------------------------------------------
 * Find @CheckAtRuntime
 * ---------------------------------------------------------------------------
 */

function findCheckAtRuntime(source, start) {
  let i = start;

  while (i < source.length) {
    if (
      source[i] === "/" &&
      source[i + 1] === "/"
    ) {
      i = skipLineComment(source, i);
      continue;
    }

    if (
      source[i] === "/" &&
      source[i + 1] === "*"
    ) {
      i = skipBlockComment(source, i);
      continue;
    }

    if (
      source[i] === "'" ||
      source[i] === '"' ||
      source[i] === "`"
    ) {
      i = skipString(source, i);
      continue;
    }

    if (source.startsWith("@CheckAtRuntime", i)) {
      return i;
    }

    i++;
  }

  return -1;
}


/*
 * ---------------------------------------------------------------------------
 * Find decorated function
 * ---------------------------------------------------------------------------
 */
function findDecoratedFunction(source, decoratorStart) {
  let i = decoratorStart + "@CheckAtRuntime".length;

  /*
   * Allow whitespace/comments between decorator and declaration.
   */
  i = skipWhitespaceAndComments(source, i);

  /*
   * Supported declarations:
   *
   *   function foo(...)
   *   async function foo(...)
   *   export function foo(...)
   *   export async function foo(...)
   *
   * We deliberately only support declarations, not:
   *
   *   const foo = async (...) => {}
   *   const foo = function (...) {}
   *
   * Those can be added separately if needed.
   */

  const declarationStart = i;

  /*
   * Optional `export`.
   */
  if (isKeywordAt(source, i, "export")) {
    i += "export".length;
    i = skipWhitespaceAndComments(source, i);
  }

  /*
   * Optional `default`.
   *
   * This also allows:
   *
   *   export default function foo(...)
   *
   *   export default async function foo(...)
   */
  if (isKeywordAt(source, i, "default")) {
    i += "default".length;
    i = skipWhitespaceAndComments(source, i);
  }

  /*
   * Optional `async`.
   */
  if (isKeywordAt(source, i, "async")) {
    i += "async".length;
    i = skipWhitespaceAndComments(source, i);
  }

  /*
   * The declaration must ultimately be a function.
   */
  if (!isKeywordAt(source, i, "function")) {
    return null;
  }

  i += "function".length;

  /*
   * Optional generator `*`.
   */
  i = skipWhitespaceAndComments(source, i);

  if (source[i] === "*") {
    i++;
    i = skipWhitespaceAndComments(source, i);
  }

  /*
   * Function name.
   *
   * Function declarations normally have a name, so require one.
   */
  const nameStart = i;

  while (
    i < source.length &&
    isIdentifierPart(source[i])
  ) {
    i++;
  }

  if (i === nameStart) {
    return null;
  }

  i = skipWhitespaceAndComments(source, i);

  /*
   * Find opening `(`.
   */
  if (source[i] !== "(") {
    return null;
  }

  const paramsStart = i;

  const paramsEnd = findMatching(
    source,
    paramsStart,
    "(",
    ")",
  );

  if (paramsEnd === -1) {
    return null;
  }

  const paramsSource = source.slice(
    paramsStart + 1,
    paramsEnd,
  );

  const params = parseParameters(paramsSource);

  i = paramsEnd + 1;

  /*
   * Skip return type:
   *
   *   function foo(x: X): Y {
   *                         ^
   */
  i = skipWhitespaceAndComments(source, i);

  if (source[i] === ":") {
    i++;

    i = skipTypeUntilBody(source, i);
  }

  i = skipWhitespaceAndComments(source, i);

  if (source[i] !== "{") {
    return null;
  }

  return {
    /*
     * IMPORTANT:
     *
     * Start at `export` / `async` / `function`, rather than
     * always starting at `function`.
     *
     * This causes the rewritten source to preserve:
     *
     *   export
     *   async
     *   export async
     */
    functionStart: declarationStart,

    paramsStart,
    paramsEnd,
    bodyStart: i,
    params,
  };
}


/*
 * ---------------------------------------------------------------------------
 * Keyword helper
 * ---------------------------------------------------------------------------
 *
 * Unlike source.startsWith(), this makes sure we found a complete keyword.
 *
 * For example:
 *
 *   exportFunction
 *
 * must NOT match `export`.
 */

function isKeywordAt(source, index, keyword) {
  if (!source.startsWith(keyword, index)) {
    return false;
  }

  const before = source[index - 1];
  const after = source[index + keyword.length];

  if (
    before !== undefined &&
    isIdentifierPart(before)
  ) {
    return false;
  }

  if (
    after !== undefined &&
    isIdentifierPart(after)
  ) {
    return false;
  }

  return true;
}

/*
 * ---------------------------------------------------------------------------
 * Parse parameters
 * ---------------------------------------------------------------------------
 */

function parseParameters(source) {
  const parts = splitTopLevel(source, ",");

  return parts
    .map((part) => parseParameter(part.trim()))
    .filter(Boolean);
}


function parseParameter(source) {
  if (!source) {
    return null;
  }

  /*
   * Rest parameters are deliberately ignored.
   */
  if (source.startsWith("...")) {
    return {
      source,
      name: null,
      type: null,
      optional: false,
      rest: true,
    };
  }

  let text = source.trim();

  /*
   * Remove access modifiers.
   *
   * constructor(public user: User)
   */
  text = text.replace(
    /^(public|private|protected|readonly)\s+/,
    "",
  );

  /*
   * Parameter properties can have multiple modifiers.
   */
  text = text.replace(
    /^(public|private|protected|readonly)\s+/g,
    "",
  );

  /*
   * Find the top-level `:` separating name and type.
   */
  const colon = findTopLevel(text, ":");

  if (colon === -1) {
    return {
      source,
      name: extractParameterName(text),
      type: null,
      optional: false,
      rest: false,
    };
  }

  const left = text.slice(0, colon).trim();
  const right = text.slice(colon + 1).trim();

  const optional = left.endsWith("?");

  const name = extractParameterName(
    optional ? left.slice(0, -1) : left,
  );

  return {
    source,
    name,
    type: right,
    optional,
    rest: false,
  };
}


function extractParameterName(source) {
  const text = source.trim();

  /*
   * Simple identifier:
   *
   *   user
   *   user?
   */
  const match = text.match(
    /^[A-Za-z_$][\w$]*$/,
  );

  if (match) {
    return match[0];
  }

  /*
   * Destructuring is intentionally unsupported for runtime
   * parameter checking.
   */
  return null;
}


/*
 * ---------------------------------------------------------------------------
 * Remove parameter TypeScript annotations
 * ---------------------------------------------------------------------------
 */

function removeParameterTypes(
  functionSource,
  paramsStart,
  paramsEnd,
) {
  /*
   * functionSource contains:
   *
   *   function foo(a: string, b: User)
   *
   * paramsStart/paramsEnd are absolute positions in the original
   * source, so convert them to local offsets.
   */
  const functionStartOffset = paramsStart -
    (
      paramsStart -
      functionSource.indexOf("(")
    );

  /*
   * Rather than relying on offsets above, simply locate the first
   * parameter list in this function source.
   */
  const open = functionSource.indexOf("(");

  if (open === -1) {
    return functionSource;
  }

  const close = findMatching(
    functionSource,
    open,
    "(",
    ")",
  );

  if (close === -1) {
    return functionSource;
  }

  const paramsText = functionSource.slice(
    open + 1,
    close,
  );

  const params = splitTopLevel(
    paramsText,
    ",",
  );

  const cleaned = params.map(
    removeSingleParameterType,
  );

  return (
    functionSource.slice(0, open + 1) +
    cleaned.join(",") +
    functionSource.slice(close)
  );
}


function removeSingleParameterType(parameter) {
  const text = parameter.trim();

  if (!text) {
    return parameter;
  }

  /*
   * Rest parameter.
   */
  if (text.startsWith("...")) {
    return parameter;
  }

  const colon = findTopLevel(text, ":");

  if (colon === -1) {
    return parameter;
  }

  const left = text.slice(0, colon).trim();
  const right = text.slice(colon + 1).trim();

  /*
   * Preserve default values.
   *
   *   user: User = new User()
   *
   * becomes:
   *
   *   user = new User()
   */
  const equals = findTopLevel(right, "=");

  let defaultValue = "";

  if (equals !== -1) {
    defaultValue = right.slice(equals).trim();
  }

  return `${left}${defaultValue ? ` ${defaultValue}` : ""}`;
}


/*
 * ---------------------------------------------------------------------------
 * Runtime checks
 * ---------------------------------------------------------------------------
 */

function runtimeCheckForParameter(param) {
  if (!param || !param.name || !param.type) {
    return null;
  }

  if (param.rest) {
    return null;
  }

  const type = param.type.trim();

  if (!type) {
    return null;
  }

  /*
   * These types do not require runtime checking.
   */
  if (
    type === "any" ||
    type === "unknown" ||
    type === "never"
  ) {
    return null;
  }

  /*
   * Optional parameters:
   *
   *   user?: User
   *
   * should allow undefined.
   */
  const optionalPrefix = param.optional
    ? `${param.name} !== undefined && `
    : "";

  /*
   * Primitive types.
   */
  const primitiveTypes = new Set([
    "string",
    "number",
    "boolean",
    "bigint",
    "symbol",
    "function",
  ]);

  if (primitiveTypes.has(type)) {
    return (
      `if (${optionalPrefix}typeof ${param.name} !== "${type}") ` +
      `{ throw new TypeError("${param.name} must be ${type}"); }`
    );
  }

  /*
   * object:
   *
   * Functions are not considered objects here.
   */
  if (type === "object") {
    return (
      `if (${optionalPrefix}(${param.name} === null || ` +
      `typeof ${param.name} !== "object")) ` +
      `{ throw new TypeError("${param.name} must be object"); }`
    );
  }

  /*
   * null.
   */
  if (type === "null") {
    return (
      `if (${optionalPrefix}${param.name} !== null) ` +
      `{ throw new TypeError("${param.name} must be null"); }`
    );
  }

  /*
   * undefined.
   */
  if (type === "undefined") {
    return (
      `if (${param.name} !== undefined) ` +
      `{ throw new TypeError("${param.name} must be undefined"); }`
    );
  }

  /*
   * Simple class/type reference:
   *
   *   User
   *   models.User
   *
   * These become:
   *
   *   value instanceof User
   */
  if (isSimpleTypeReference(type)) {
    return (
      `if (${optionalPrefix}!(`
      + `${param.name} instanceof ${type}`
      + `)) { `
      + `throw new TypeError("${param.name} must be ${type}"); `
      + `}`
    );
  }

  /*
   * Complex TypeScript types cannot safely be inferred into a
   * runtime check by this lightweight lexical transformer.
   *
   * Examples:
   *
   *   string | number
   *   User[]
   *   Promise<User>
   *   { id: number }
   *   Foo & Bar
   *
   * These are left alone.
   */
  return null;
}


function isSimpleTypeReference(type) {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(
    type,
  );
}


/*
 * ---------------------------------------------------------------------------
 * Lexical helpers
 * ---------------------------------------------------------------------------
 */

function splitTopLevel(source, separator) {
  const result = [];

  let start = 0;

  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;

  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (
      char === "'" ||
      char === '"' ||
      char === "`"
    ) {
      i = skipString(source, i);
      continue;
    }

    if (
      char === "/" &&
      source[i + 1] === "/"
    ) {
      i = skipLineComment(source, i);
      continue;
    }

    if (
      char === "/" &&
      source[i + 1] === "*"
    ) {
      i = skipBlockComment(source, i);
      continue;
    }

    if (char === "(") paren++;
    else if (char === ")") paren--;

    else if (char === "[") bracket++;
    else if (char === "]") bracket--;

    else if (char === "{") brace++;
    else if (char === "}") brace--;

    else if (char === "<") angle++;
    else if (char === ">") angle--;

    if (
      char === separator &&
      paren === 0 &&
      bracket === 0 &&
      brace === 0 &&
      angle === 0
    ) {
      result.push(
        source.slice(start, i),
      );

      start = i + 1;
    }

    i++;
  }

  result.push(source.slice(start));

  return result;
}


function findTopLevel(source, wanted) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;

  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (
      char === "'" ||
      char === '"' ||
      char === "`"
    ) {
      i = skipString(source, i);
      continue;
    }

    if (
      char === "/" &&
      source[i + 1] === "/"
    ) {
      i = skipLineComment(source, i);
      continue;
    }

    if (
      char === "/" &&
      source[i + 1] === "*"
    ) {
      i = skipBlockComment(source, i);
      continue;
    }

    if (char === "(") paren++;
    else if (char === ")") paren--;

    else if (char === "[") bracket++;
    else if (char === "]") bracket--;

    else if (char === "{") brace++;
    else if (char === "}") brace--;

    else if (char === "<") angle++;
    else if (char === ">") angle--;

    if (
      char === wanted &&
      paren === 0 &&
      bracket === 0 &&
      brace === 0 &&
      angle === 0
    ) {
      return i;
    }

    i++;
  }

  return -1;
}


function findMatching(
  source,
  start,
  open,
  close,
) {
  let depth = 0;

  let i = start;

  while (i < source.length) {
    const char = source[i];

    if (
      char === "'" ||
      char === '"' ||
      char === "`"
    ) {
      i = skipString(source, i);
      continue;
    }

    if (
      char === "/" &&
      source[i + 1] === "/"
    ) {
      i = skipLineComment(source, i);
      continue;
    }

    if (
      char === "/" &&
      source[i + 1] === "*"
    ) {
      i = skipBlockComment(source, i);
      continue;
    }

    if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;

      if (depth === 0) {
        return i;
      }
    }

    i++;
  }

  return -1;
}


function skipTypeUntilBody(source, start) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;

  let i = start;

  while (i < source.length) {
    const char = source[i];

    if (
      char === "'" ||
      char === '"' ||
      char === "`"
    ) {
      i = skipString(source, i);
      continue;
    }

    if (
      char === "/" &&
      source[i + 1] === "/"
    ) {
      i = skipLineComment(source, i);
      continue;
    }

    if (
      char === "/" &&
      source[i + 1] === "*"
    ) {
      i = skipBlockComment(source, i);
      continue;
    }

    if (char === "(") paren++;
    else if (char === ")") paren--;

    else if (char === "[") bracket++;
    else if (char === "]") bracket--;

    else if (char === "{") brace++;
    else if (char === "}") brace--;

    else if (char === "<") angle++;
    else if (char === ">") angle--;

    if (
      char === "{" &&
      paren === 0 &&
      bracket === 0 &&
      brace === 1 &&
      angle === 0
    ) {
      return i;
    }

    i++;
  }

  return i;
}


function skipWhitespaceAndComments(source, start) {
  let i = start;

  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }

    if (
      source[i] === "/" &&
      source[i + 1] === "/"
    ) {
      i = skipLineComment(source, i);
      continue;
    }

    if (
      source[i] === "/" &&
      source[i + 1] === "*"
    ) {
      i = skipBlockComment(source, i);
      continue;
    }

    break;
  }

  return i;
}


function skipLineComment(source, start) {
  const newline = source.indexOf(
    "\n",
    start + 2,
  );

  return newline === -1
    ? source.length
    : newline + 1;
}


function skipBlockComment(source, start) {
  const end = source.indexOf(
    "*/",
    start + 2,
  );

  return end === -1
    ? source.length
    : end + 2;
}


function skipString(source, start) {
  const quote = source[start];

  let i = start + 1;

  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }

    if (source[i] === quote) {
      return i + 1;
    }

    i++;
  }

  return source.length;
}


function isIdentifierPart(char) {
  return (
    char !== undefined &&
    /[A-Za-z0-9_$]/.test(char)
  );
}

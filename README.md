#### Currently Experimental, for https://nyno.dev (v10, coming soon)

# Run JavaScript/TypeScript without strict rules + runtime type checking for functions (using @CheckAtRuntime)

jt lets you use TypeScript syntax directly in Node.js without requiring types everywhere or enforcing a strict TypeScript workflow.

It transpiles `.ts` and `.tsx` files in memory using esbuild and otherwise behaves like normal Node.js.

When you want runtime type checking, use `@CheckAtRuntime`:

```ts
@CheckAtRuntime
function greet(user: User, name: string) {
    console.log(`Hello ${name}`);
}

greet(new User(), "John");

greet("wrong", 123);
// TypeError: user must be User
```

Without `@CheckAtRuntime`, types are optional and are simply transpiled away:

```ts
function greet(name: string) {
    console.log(name);
}

greet(123); // runs normally
```

### Benefits

* **No compilation step** — run your TypeScript directly with no separate build or compile process.
* **Built on Node.js** — keep using the stable, production-proven JavaScript runtime, currently Node.js v24.
* **Runtime type checking when you want it** — add a single `@CheckAtRuntime` decorator to TypeScript functions to immediately validate their arguments at runtime.
* **TypeScript without the strictness** — use TypeScript syntax while keeping the flexibility and simplicity of JavaScript.


### Features

* TypeScript syntax in Node.js
* No strict typing rules
* `.ts` / `.tsx` with ESM imports
* In-memory esbuild transpilation
* `@CheckAtRuntime` for runtime type checking
* Automatically loads .env from the script directory
* Source maps in `.source-map/`
* Normal Node.js `process.argv`

### Usage

```bash
jt server.ts arg1 arg2
```

### Install

```bash
git clone https://github.com/flowagi-eu/jt
cd jt
npm install
npm link
```

### Philosophy

- Use TypeScript syntax when you want it. 
- Keep JavaScript's freedom.
- Quickly add runtime type checking without learning additional libraries.


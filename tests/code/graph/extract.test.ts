import { describe, test, expect } from "bun:test";
import { extractCodeFile } from "../../../src/code/graph/extract/code.ts";

describe("extractCodeFile — TypeScript", () => {
  test("emits module + function + class nodes and import edges", async () => {
    const src = `import { foo } from "./foo";
import bar from "bar";
export function hello(x: number): string { return "hi" + x; }
export class Box<T> {
  constructor(public value: T) {}
  peek() { return this.value; }
}`;
    const ex = await extractCodeFile("app.ts", src);
    const kinds = ex.nodes.map((n) => n.kind);
    expect(kinds).toContain("module");
    expect(kinds).toContain("function");
    expect(kinds).toContain("class");
    expect(kinds).toContain("method");

    const imports = ex.edges.filter((e) => e.kind === "imports");
    expect(imports.length).toBe(2);
    expect(imports.every((e) => e.confidence === 1)).toBe(true);
  });
});

describe("extractCodeFile — Python", () => {
  test("captures both `import x` and `from y import z`", async () => {
    const src = `from math import sqrt
import os
def greet(name):
    return "hi " + name
class Cat:
    def meow(self): pass
`;
    const ex = await extractCodeFile("app.py", src);
    const targets = ex.edges
      .filter((e) => e.kind === "imports")
      .map((e) => e.to);
    expect(targets).toEqual(expect.arrayContaining(["external:math", "external:os"]));
    const names = ex.nodes.map((n) => n.name);
    expect(names).toContain("greet");
    expect(names).toContain("Cat");
    expect(names).toContain("meow");
  });
});

describe("extractCodeFile — Go", () => {
  test("captures imports, functions, methods, and type declarations", async () => {
    const src = `package main
import "fmt"
import _ "io"
type User struct { Name string }
func (u *User) Hello() string { return "hi " + u.Name }
func main() { fmt.Println("x") }
`;
    const ex = await extractCodeFile("app.go", src);
    const names = ex.nodes.map((n) => n.name);
    expect(names).toContain("User");
    expect(names).toContain("Hello");
    expect(names).toContain("main");
    const imports = ex.edges.filter((e) => e.kind === "imports");
    expect(imports.length).toBe(2);
  });
});

describe("extractCodeFile — Rust", () => {
  test("captures use declarations, functions, traits, and structs", async () => {
    const src = `use std::io;
use serde::Serialize;
struct Foo { x: i32 }
fn add(a: i32, b: i32) -> i32 { a + b }
trait Greeter { fn hello(&self); }
`;
    const ex = await extractCodeFile("app.rs", src);
    const names = ex.nodes.map((n) => n.name);
    expect(names).toContain("Foo");
    expect(names).toContain("add");
    expect(names).toContain("Greeter");
    const imports = ex.edges.filter((e) => e.kind === "imports");
    expect(imports.length).toBe(2);
  });
});

describe("extractCodeFile — unsupported languages", () => {
  test("Java falls back to module-only extraction", async () => {
    const src = `public class Hello { public static void main(String[] args) {} }`;
    const ex = await extractCodeFile("Hello.java", src);
    expect(ex.nodes.length).toBe(1);
    expect(ex.nodes[0]?.kind).toBe("module");
    expect(ex.edges.length).toBe(0);
  });

  test("Unknown extension falls back to module-only extraction", async () => {
    const ex = await extractCodeFile("readme", "hello");
    expect(ex.nodes.length).toBe(1);
    expect(ex.edges.length).toBe(0);
  });
});

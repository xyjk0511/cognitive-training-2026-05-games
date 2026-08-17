declare module "node:crypto" {
  export function createHash(name: string): { update(data: string | Uint8Array): any; digest(encoding: "hex"): string };
}
declare module "node:fs" { export function readFileSync(path: string, encoding: "utf8"): string; }
declare module "node:path" { export function resolve(...paths: string[]): string; }
declare const process: { cwd(): string };

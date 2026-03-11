declare module 'js-yaml' {
  export function load(input: string, options?: LoadOptions): unknown;
  export function dump(obj: unknown, options?: DumpOptions): string;
  
  interface LoadOptions {
    filename?: string;
    onWarning?: (warning: Error) => void;
    schema?: unknown;
    json?: boolean;
  }
  
  interface DumpOptions {
    indent?: number;
    noArrayIndent?: boolean;
    skipInvalid?: boolean;
    flowLevel?: number;
    styles?: Record<string, unknown>;
    schema?: unknown;
    sortKeys?: boolean | ((a: string, b: string) => number);
    lineWidth?: number;
    noRefs?: boolean;
    noCompatMode?: boolean;
    condenseFlow?: boolean;
    quotingType?: "'" | '"';
    forceQuotes?: boolean;
    replacer?: (key: string, value: unknown) => unknown;
  }
}

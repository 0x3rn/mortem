declare module "node:sqlite" {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...anonymousParameters: SQLInputValue[]): StatementResultingChanges;
    get(
      ...anonymousParameters: SQLInputValue[]
    ): Record<string, unknown> | undefined;
    all(...anonymousParameters: SQLInputValue[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

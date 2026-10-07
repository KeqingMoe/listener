import type { Api, Model as PiModel } from '@earendil-works/pi-ai';
import type { GroupId } from '@listener/chat';

export const configError = {
  notToml: '不是合法的 TOML',
  shape: '配置形状不合法',
  deriveSelf: '不能 derive 自己',
  deriveMissing: 'derive 的 parent 不存在',
  deriveCycle: 'derive 成环',
  deriveNotTable: 'derive 必须指向表',
  modelRequired: 'model 必填',
} as const;

export function fail(message: string): never {
  throw new Error(message);
}

export type Mentioned = {
  at: boolean;
  reply: boolean;
};

export type Open = {
  window: number;
  poisson: number;
  mentioned: Mentioned;
};

export type GroupTable = {
  model: string;
  persona: string;
  open: Open;
};

export type Group = false | GroupTable;

type Leaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | ((...args: never[]) => unknown)
  | (string & {});

export type PartialDeep<T> = T extends Leaf
  ? T
  : T extends string
    ? T
    : T extends readonly unknown[]
      ? T
      : string extends keyof T
        ? T extends Record<string, infer V>
          ? V extends Leaf | string
            ? T
            : { [K in keyof T]?: PartialDeep<T[K]> }
          : T
        : T extends object
          ? { [K in keyof T]?: PartialDeep<T[K]> }
          : T;

type PlainObject<T> = T extends object
  ? T extends readonly unknown[]
    ? never
    : T extends string
      ? never
      : string extends keyof T
        ? T extends Record<string, infer V>
          ? V extends Leaf | string
            ? never
            : T
          : never
        : T
  : never;

export type Merge<B, O> = [O] extends [undefined]
  ? B
  : [B] extends [undefined]
    ? O
    : PlainObject<B> extends never
      ? O
      : PlainObject<O> extends never
        ? O
        : {
            [K in keyof B | keyof O]: K extends keyof O
              ? K extends keyof B
                ? Merge<B[K], Exclude<O[K], undefined>>
                : Exclude<O[K], undefined>
              : K extends keyof B
                ? B[K]
                : never;
          };

export type Model = Omit<PiModel<Api>, 'id' | 'provider'>;

export type Provider = {
  name: string;
  apiKeyEnv: string;
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  models: Record<string, Model>;
  derive?: string;
};

export type OnebotConfig = {
  url: string;
  tokenEnv: string;
};

export type ProviderConfig = Record<string, Provider>;

export type GroupConfig = Record<GroupId, Group> & { default: Group };

export type AppConfig = {
  onebot: OnebotConfig;
  providers: ProviderConfig;
  groups: GroupConfig;
};

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function camelDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelDeep);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[camel(key)] = camelDeep(nested);
    }
    return out;
  }
  return value;
}

function table(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return table(value) !== undefined;
}

// 表按键并，嵌套对象按字段并，undefined 跳过，数组和叶子整段替换。
export function merge<B, O>(base: B, overlay: O): Merge<B, O> {
  if (overlay === undefined) {
    return base as Merge<B, O>;
  }
  if (!isTable(base) || !isTable(overlay)) {
    return overlay as Merge<B, O>;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) {
      continue;
    }
    out[key] = merge(base[key], value);
  }
  return out as Merge<B, O>;
}

export function topo(
  ids: string[],
  parentOf: (id: string) => string | undefined,
): string[] {
  const inFile = new Set(ids);
  const done = new Set<string>();
  const stack = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (done.has(id)) {
      return;
    }
    if (stack.has(id)) {
      fail(configError.deriveCycle);
    }
    const parent = parentOf(id);
    if (parent === id) {
      fail(configError.deriveSelf);
    }
    stack.add(id);
    if (parent !== undefined && inFile.has(parent)) {
      visit(parent);
    }
    stack.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const id of ids) {
    visit(id);
  }
  return order;
}

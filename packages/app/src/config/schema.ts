import { type Static, Type } from 'typebox';

const closed = { additionalProperties: false } as const;

export const mentionedTable = Type.Object(
  {
    at: Type.Optional(Type.Boolean()),
    reply: Type.Optional(Type.Boolean()),
  },
  closed,
);

export const openFile = Type.Object(
  {
    window: Type.Optional(Type.Integer({ minimum: 0 })),
    poisson: Type.Optional(Type.Number({ minimum: 0 })),
    mentioned: Type.Optional(Type.Union([Type.Boolean(), mentionedTable])),
  },
  closed,
);

export const groupFile = Type.Union([
  Type.Literal(false),
  Type.Object(
    {
      derive: Type.Optional(Type.String({ minLength: 1 })),
      model: Type.Optional(Type.String({ minLength: 1 })),
      persona: Type.Optional(Type.String()),
      open: Type.Optional(openFile),
    },
    closed,
  ),
]);

// 只收 derive，其余字段开放，加载时 camel 成 PartialDeep<Provider>。
export const providerFile = Type.Object(
  {
    derive: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: true },
);

export const onebotFile = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    token_env: Type.Optional(Type.String({ minLength: 1 })),
  },
  closed,
);

export const configFile = Type.Object(
  {
    onebot: onebotFile,
    providers: Type.Optional(Type.Record(Type.String(), providerFile)),
    groups: Type.Optional(Type.Record(Type.String(), groupFile)),
  },
  closed,
);

export type ConfigFile = Static<typeof configFile>;
export type GroupFile = Static<typeof groupFile>;
export type ProviderFile = Static<typeof providerFile> &
  Record<string, unknown>;

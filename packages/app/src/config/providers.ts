import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ProviderFile } from './schema';
import {
  camelDeep,
  configError,
  fail,
  type Model,
  merge,
  type PartialDeep,
  type Provider,
  type ProviderConfig,
  topo,
} from './shared';

const builtins: Record<string, Provider> = {};
for (const builtin of builtinProviders()) {
  const models: Record<string, Model> = {};
  for (const model of builtin.getModels()) {
    const { id, provider: _, ...rest } = model;
    models[id] = rest;
  }
  builtins[builtin.id] = {
    name: builtin.name,
    apiKeyEnv: '', // 空 = 走 Pi 默认环境变量
    baseUrl: builtin.baseUrl,
    models,
  };
}

function complete(id: string, merged: PartialDeep<Provider>): Provider {
  const models = {};
  return { ...{ name: id, models, apiKeyEnv: '' }, ...merged };
}

export function resolveProviders(
  file: Record<string, ProviderFile>,
): ProviderConfig {
  const resolved: ProviderConfig = { ...builtins };
  for (const id of topo(Object.keys(file), id => file[id]?.derive)) {
    const { derive, ...rest } = file[id]!;
    const parent =
      derive === undefined
        ? resolved[id]
        : (resolved[derive] ?? fail(configError.deriveMissing));
    const patch = camelDeep(rest) as PartialDeep<Provider>;
    resolved[id] = {
      ...complete(id, merge(parent, patch)),
      derive: parent?.derive ?? derive,
    };
  }
  return resolved;
}

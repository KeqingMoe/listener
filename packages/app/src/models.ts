import {
  type AnyModel,
  createProvider,
  envApiKeyAuth,
  type MutableModels,
  type Provider as PiProvider,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { getApiProvider } from '@earendil-works/pi-ai/compat';
import {
  builtinModels,
  builtinProviders,
} from '@earendil-works/pi-ai/providers/all';
import type { Provider, ProviderConfig } from './config/shared';

function protocols(provider: Provider): string[] {
  const names = new Set<string>();
  if (provider.api !== undefined) {
    names.add(provider.api);
  }

  for (const model of Object.values(provider.models)) {
    if (model.api !== undefined) {
      names.add(model.api);
    }
  }
  return [...names];
}

function streamsFor(
  provider: Provider,
  root?: PiProvider,
): ProviderStreams | Record<string, ProviderStreams> {
  if (root !== undefined) {
    return {
      stream: root.stream.bind(root),
      streamSimple: root.streamSimple.bind(root),
    };
  }

  const api: Record<string, ProviderStreams> = {};
  for (const name of protocols(provider)) {
    const proto = getApiProvider(name);
    if (proto === undefined) {
      throw new Error('找不到这个协议');
    }
    api[name] = proto;
  }
  return api;
}

export function modelsFromConfig(
  providerConfig: ProviderConfig,
  providers: readonly string[],
): MutableModels {
  const builtins = new Map<string, PiProvider>();
  for (const builtin of builtinProviders()) {
    builtins.set(builtin.id, builtin);
  }

  const models = builtinModels();

  for (const provider of providers) {
    const config = providerConfig[provider];
    if (config === undefined) {
      throw new Error('找不到这个模型');
    }

    const root = builtins.get(config.derive ?? provider);
    const catalog = Object.entries(config.models).map(([modelId, model]) => ({
      ...{
        api: config.api,
        baseUrl: config.baseUrl,
      },
      ...model,
      id: modelId,
      provider,
      headers: { ...config.headers, ...model.headers },
    }));

    const filled: Provider = {
      ...config,
      models: Object.fromEntries(catalog.map(model => [model.id, model])),
    };

    models.setProvider(
      createProvider({
        id: provider,
        name: config.name,
        auth:
          config.apiKeyEnv.length > 0
            ? { apiKey: envApiKeyAuth(provider, [config.apiKeyEnv]) }
            : (root?.auth ?? { apiKey: envApiKeyAuth(provider, []) }),
        models: catalog as AnyModel[],
        api: streamsFor(filled, root),
      }),
    );
  }

  return models;
}

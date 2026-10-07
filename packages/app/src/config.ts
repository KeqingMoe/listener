import { parse as parseToml } from 'smol-toml';
import { Compile } from 'typebox/compile';
import { resolveGroups } from './config/groups';
import { resolveProviders } from './config/providers';
import { type ConfigFile, configFile } from './config/schema';
import { type AppConfig, configError, fail } from './config/shared';

const fileCheck = Compile(configFile);

function resolve(file: ConfigFile): AppConfig {
  return {
    onebot: {
      url: file.onebot.url,
      tokenEnv: file.onebot.token_env ?? 'ONEBOT_ACCESS_TOKEN',
    },
    providers: resolveProviders(file.providers ?? {}),
    groups: resolveGroups(file.groups ?? {}),
  };
}

export function parse(toml: string): AppConfig {
  let parsed: unknown;
  try {
    parsed = parseToml(toml);
  } catch {
    fail(configError.notToml);
  }

  if (!fileCheck.Check(parsed)) {
    const first = fileCheck.Errors(parsed)[0];
    fail(
      first === undefined
        ? configError.shape
        : `${configError.shape}：${first.instancePath}`,
    );
  }

  return resolve(parsed);
}

export type {
  AppConfig,
  Group,
  GroupConfig,
  GroupTable,
  Mentioned,
  Model,
  OnebotConfig,
  Open,
  Provider,
  ProviderConfig,
} from './config/shared';
export { configError } from './config/shared';

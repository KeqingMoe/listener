import { describe, expect, it } from 'vitest';
import { parse } from '@/config';
import { modelsFromConfig } from '@/models';

describe('modelsFromConfig', () => {
  it('空 providers 也能 getModel 内置', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[groups.'10001']
model = 'opencode-go/deepseek-v4.1-flash'
`);
    const models = modelsFromConfig(config.providers, ['opencode-go']);
    expect(models.getModel('opencode-go', 'deepseek-v4.1-flash')).toBeDefined();
  });

  it('配置改名盖掉内置', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[providers.opencode-go]
name = 'work'

[groups.'10001']
model = 'opencode-go/deepseek-v4.1-flash'
`);
    const models = modelsFromConfig(config.providers, ['opencode-go']);
    expect(models.getProvider('opencode-go')?.name).toBe('work');
    expect(models.getModel('opencode-go', 'deepseek-v4.1-flash')).toBeDefined();
  });

  it('模型没写 baseUrl 才用 provider 的', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[providers.proxy]
base_url = 'https://example.test'
api = 'openai-completions'
api_key_env = 'PROXY_API_KEY'

[providers.proxy.models.demo]

[groups.'10001']
model = 'proxy/demo'
`);
    const models = modelsFromConfig(config.providers, ['proxy']);
    expect(models.getModel('proxy', 'demo')?.baseUrl).toBe(
      'https://example.test',
    );
  });

  it('derive 链是三个实例，叶子能 getModel', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[providers.mid]
derive = 'opencode-go'
api_key_env = 'MID_KEY'

[providers.leaf]
derive = 'mid'
api_key_env = 'LEAF_KEY'

[groups.'10001']
model = 'leaf/deepseek-v4.1-flash'
`);
    const models = modelsFromConfig(config.providers, ['leaf']);
    expect(models.getProvider('leaf')).toBeDefined();
    expect(models.getModel('leaf', 'deepseek-v4.1-flash')).toBeDefined();
    expect(models.getModel('leaf', 'deepseek-v4.1-flash')?.provider).toBe(
      'leaf',
    );
  });

  it('自定义根按 api 建模型', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[providers.proxy]
base_url = 'https://example.test/v1'
api = 'openai-completions'
api_key_env = 'PROXY_API_KEY'

[providers.proxy.models.demo]

[groups.'10001']
model = 'proxy/demo'
`);
    const models = modelsFromConfig(config.providers, ['proxy']);
    const model = models.getModel('proxy', 'demo');
    expect(model?.api).toBe('openai-completions');
    expect(model?.baseUrl).toBe('https://example.test/v1');
  });

  it('重建 opencode-go 后 session header 还在不在', async () => {
    const toml = `
[onebot]
url = 'ws://127.0.0.1:3001'

[groups.'10001']
model = 'opencode-go/deepseek-v4.1-flash'
`;
    const rebuilt = modelsFromConfig(parse(toml).providers, ['opencode-go']);
    const model = rebuilt.getModel('opencode-go', 'deepseek-v4.1-flash');
    if (model === undefined) {
      throw new Error('没有这个模型');
    }
    let header: string | undefined;
    const streamResult = rebuilt.streamSimple(
      model,
      { messages: [] },
      {
        apiKey: 'test-key',
        sessionId: 'sess-1',
        fetch: async (_input, init) => {
          header =
            new Headers(init?.headers).get('x-opencode-session') ?? undefined;
          return new Response('{}', { status: 200 });
        },
      },
    );
    for await (const _ of streamResult) {
    }
    expect(header).toBe('sess-1');
  });
});

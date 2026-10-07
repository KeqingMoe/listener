import { GroupId } from '@listener/chat';
import { describe, expect, it } from 'vitest';
import { configError, parse } from '@/config';

const base = `

[groups.base]
model = 'opencode-go/deepseek-v4.1-flash'
persona = 'persona.md'
open = { window = 20, poisson = 8, mentioned = true }

`;

describe('parse', () => {
  it('预设 derive，mentioned 按字段覆盖', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'
${base}
[groups.'10001']
derive = 'base'

[groups.'10002']
derive = 'base'
persona = 'other.md'
open.mentioned = { at = true, reply = false }
`);
    expect(config.onebot).toEqual({
      url: 'ws://127.0.0.1:3001',
      tokenEnv: 'ONEBOT_ACCESS_TOKEN',
    });
    expect(config.groups.default).toBe(false);
    const a = config.groups[GroupId('10001')!];
    const b = config.groups[GroupId('10002')!];
    expect(a === false ? undefined : a?.persona).toBe('persona.md');
    expect(a === false ? undefined : a?.open).toEqual({
      window: 20,
      poisson: 8,
      mentioned: { at: true, reply: true },
    });
    expect(b === false ? undefined : b?.persona).toBe('other.md');
    expect(b === false ? undefined : b?.open?.mentioned).toEqual({
      at: true,
      reply: false,
    });
    expect(b === false ? undefined : b?.model).toBe(
      'opencode-go/deepseek-v4.1-flash',
    );
  });

  it('persona 空字符串表示无人设', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'
${base}
[groups.'10001']
derive = 'base'
persona = ''
`);
    const group = config.groups[GroupId('10001')!];
    expect(group === false ? undefined : group?.persona).toBe('');
  });

  it('黑名单：default 是表，false 的号留在表里', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[groups]
'10002' = false

[groups.base]
model = 'opencode-go/deepseek-v4.1-flash'
persona = 'persona.md'
open = { window = 20, poisson = 8, mentioned = true }

[groups.default]
derive = 'base'
`);
    expect(config.groups.default === false).toBe(false);
    expect(config.groups[GroupId('10002')!]).toBe(false);
    expect(config.groups[GroupId('10001')!]).toBeUndefined();
  });

  it('不是合法的 TOML', () => {
    expect(() => parse('=')).toThrow(configError.notToml);
  });

  it('形状不合法', () => {
    expect(() =>
      parse(`
[onebot]
url = 'ws://127.0.0.1:3001'
extra = true
`),
    ).toThrow(configError.shape);
  });

  it('不能 derive 自己', () => {
    expect(() =>
      parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[groups.base]
derive = 'base'
model = 'opencode-go/deepseek-v4.1-flash'
`),
    ).toThrow(configError.deriveSelf);
  });

  it('derive 的 parent 不存在', () => {
    expect(() =>
      parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[groups.base]
derive = 'missing'
model = 'opencode-go/deepseek-v4.1-flash'
`),
    ).toThrow(configError.deriveMissing);
  });

  it('derive 成环', () => {
    expect(() =>
      parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[groups.a]
derive = 'b'
model = 'opencode-go/deepseek-v4.1-flash'

[groups.b]
derive = 'a'
`),
    ).toThrow(configError.deriveCycle);
  });

  it('derive 必须指向表', () => {
    expect(() =>
      parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[groups]
'10001' = false

[groups.'10002']
derive = '10001'
model = 'opencode-go/deepseek-v4.1-flash'
`),
    ).toThrow(configError.deriveNotTable);
  });

  it('开着的表没有 model', () => {
    expect(() =>
      parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[groups.'10001']
persona = 'persona.md'
`),
    ).toThrow(configError.modelRequired);
  });

  it('providers 叠内置', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[providers.opencode-go]
name = 'work'

[groups.'10001']
model = 'opencode-go/deepseek-v4.1-flash'
`);
    expect(config.providers['opencode-go']?.name).toBe('work');
    expect(
      config.providers['opencode-go']?.models['deepseek-v4.1-flash'],
    ).toBeDefined();
  });

  it('没写 providers 也有内置', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[groups.'10001']
model = 'opencode-go/deepseek-v4.1-flash'
`);
    expect(
      config.providers['opencode-go']?.models['deepseek-v4.1-flash'],
    ).toBeDefined();
  });

  it('derive 折到根，数据叠到叶子', () => {
    const config = parse(`
[onebot]
url = 'ws://127.0.0.1:3001'

[providers.opencode-go]
name = 'work'

[providers.mid]
derive = 'opencode-go'
api_key_env = 'MID_KEY'

[providers.leaf]
derive = 'mid'
api_key_env = 'LEAF_KEY'

[groups.'10001']
model = 'leaf/deepseek-v4.1-flash'
`);
    expect(config.providers['opencode-go']?.derive).toBeUndefined();
    expect(config.providers.mid?.derive).toBe('opencode-go');
    expect(config.providers.leaf?.derive).toBe('opencode-go');
    expect(config.providers.leaf?.name).toBe('work');
    expect(config.providers.leaf?.apiKeyEnv).toBe('LEAF_KEY');
    expect(config.providers.leaf?.models['deepseek-v4.1-flash']).toBeDefined();
  });
});

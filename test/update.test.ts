import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('../src/provider', () => ({ log: {} }));
const { isNewer } = await import('../src/update');

describe('Versionsvergleich', () => {
  it('erkennt neuere Versionen', () => {
    expect(isNewer('v0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('v1.0.0', '0.99.0')).toBe(true);
    expect(isNewer('v0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('v0.1.9', '0.2.0')).toBe(false);
  });
});

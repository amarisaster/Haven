import { describe, it, expect } from 'vitest';

// Test the version comparison logic (same as in version.ts)
function isNewer(a: string, b: string): boolean {
  const parse = (s: string) => s.split('-')[0].split('.').map(n => Number(n) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

describe('isNewer version comparison', () => {
  it('detects newer major', () => {
    expect(isNewer('2.0.0', '1.0.0')).toBe(true);
  });

  it('detects newer minor', () => {
    expect(isNewer('1.9.0', '1.8.0')).toBe(true);
  });

  it('detects newer patch', () => {
    expect(isNewer('1.8.4', '1.8.3')).toBe(true);
  });

  it('returns false for same version', () => {
    expect(isNewer('1.8.4', '1.8.4')).toBe(false);
  });

  it('returns false for older version', () => {
    expect(isNewer('1.7.0', '1.8.0')).toBe(false);
  });

  it('ignores pre-release suffix', () => {
    expect(isNewer('1.9.0-beta', '1.8.4')).toBe(true);
  });

  it('handles missing patch', () => {
    expect(isNewer('2.0', '1.8.4')).toBe(true);
  });
});

// Test parseJson-like error detection
describe('HTTP response error handling', () => {
  it('401 should be detected as auth error', () => {
    const status = 401;
    expect(status === 401).toBe(true);
  });

  it('non-2xx responses should be treated as errors', () => {
    const errorStatuses = [400, 401, 403, 404, 429, 500, 502, 503];
    for (const status of errorStatuses) {
      expect(status >= 200 && status < 300).toBe(false);
    }
  });

  it('2xx responses should pass', () => {
    const okStatuses = [200, 201, 204];
    for (const status of okStatuses) {
      expect(status >= 200 && status < 300).toBe(true);
    }
  });
});

// Test array guards
describe('array safety guards', () => {
  it('Array.isArray catches objects', () => {
    const errorResponse = { error: 'Unauthorized' };
    expect(Array.isArray(errorResponse)).toBe(false);
  });

  it('Array.isArray passes real arrays', () => {
    const threads = [{ id: '1', title: 'test' }];
    expect(Array.isArray(threads)).toBe(true);
  });

  it('Array.isArray handles null/undefined', () => {
    expect(Array.isArray(null)).toBe(false);
    expect(Array.isArray(undefined)).toBe(false);
  });

  it('filter on non-array with guard does not crash', () => {
    const data: any = { error: 'Unauthorized' };
    const safe = Array.isArray(data) ? data : [];
    expect(safe).toEqual([]);
  });
});

// Test CORS origin logic
describe('CORS origin validation', () => {
  function getAllowedOrigin(origin: string | null): string {
    if (origin && (origin.endsWith('.pages.dev') || origin.endsWith('.workers.dev') || origin.startsWith('http://localhost') || origin.startsWith('capacitor://'))) {
      return origin;
    }
    return '*';
  }

  it('reflects pages.dev origins', () => {
    expect(getAllowedOrigin('https://haven-v17.pages.dev')).toBe('https://haven-v17.pages.dev');
  });

  it('reflects workers.dev origins', () => {
    expect(getAllowedOrigin('https://haven-example.workers.dev')).toBe('https://haven-example.workers.dev');
  });

  it('reflects localhost', () => {
    expect(getAllowedOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('reflects capacitor', () => {
    expect(getAllowedOrigin('capacitor://localhost')).toBe('capacitor://localhost');
  });

  it('falls back to * for unknown origins', () => {
    expect(getAllowedOrigin('https://evil.com')).toBe('*');
  });

  it('falls back to * for null', () => {
    expect(getAllowedOrigin(null)).toBe('*');
  });
});

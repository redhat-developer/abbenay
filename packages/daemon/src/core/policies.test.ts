import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';

let mockConfigDir = '/tmp/nonexistent-config-dir';
vi.mock('./paths.js', () => ({
  getConfigDir: () => mockConfigDir,
}));

import {
  loadCustomPolicies,
  saveCustomPolicies,
  listAllPolicies,
  resolvePolicy,
  flattenPolicy,
  getUserPoliciesPath,
  BUILTIN_POLICIES,
  BUILTIN_POLICY_NAMES,
  type PolicyConfig,
} from './policies.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-policies-test-'));
  mockConfigDir = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── getUserPoliciesPath ──────────────────────────────────────────────────────

describe('getUserPoliciesPath', () => {
  it('should return policies.yaml inside config dir', () => {
    expect(getUserPoliciesPath()).toBe(path.join(tmpDir, 'policies.yaml'));
  });
});

// ── loadCustomPolicies ───────────────────────────────────────────────────────

describe('loadCustomPolicies', () => {
  it('should return empty object when file does not exist', () => {
    expect(loadCustomPolicies()).toEqual({});
  });

  it('should load valid YAML policies', () => {
    const policies: Record<string, PolicyConfig> = {
      my_policy: {
        sampling: { temperature: 0.3 },
        output: { max_tokens: 1024 },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'policies.yaml'), yaml.dump(policies));
    const result = loadCustomPolicies();
    expect(result.my_policy).toBeDefined();
    expect(result.my_policy.sampling?.temperature).toBe(0.3);
    expect(result.my_policy.output?.max_tokens).toBe(1024);
  });

  it('should return empty object for malformed YAML', () => {
    fs.writeFileSync(path.join(tmpDir, 'policies.yaml'), ':::invalid yaml[[[');
    expect(loadCustomPolicies()).toEqual({});
  });

  it('should return empty object when YAML is an array', () => {
    fs.writeFileSync(path.join(tmpDir, 'policies.yaml'), yaml.dump(['a', 'b']));
    expect(loadCustomPolicies()).toEqual({});
  });

  it('should return empty object when YAML is a scalar', () => {
    fs.writeFileSync(path.join(tmpDir, 'policies.yaml'), 'just a string\n');
    expect(loadCustomPolicies()).toEqual({});
  });
});

// ── saveCustomPolicies ───────────────────────────────────────────────────────

describe('saveCustomPolicies', () => {
  it('should create config dir and write policies', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir');
    mockConfigDir = nestedDir;

    const policies: Record<string, PolicyConfig> = {
      test_policy: { sampling: { temperature: 0.5, top_p: 0.9 } },
    };
    saveCustomPolicies(policies);

    const written = yaml.load(
      fs.readFileSync(path.join(nestedDir, 'policies.yaml'), 'utf-8'),
    ) as Record<string, PolicyConfig>;
    expect(written.test_policy.sampling?.temperature).toBe(0.5);
  });

  it('should overwrite existing file atomically', () => {
    const policies1: Record<string, PolicyConfig> = {
      v1: { sampling: { temperature: 0.1 } },
    };
    const policies2: Record<string, PolicyConfig> = {
      v2: { sampling: { temperature: 0.9 } },
    };
    saveCustomPolicies(policies1);
    saveCustomPolicies(policies2);

    const result = loadCustomPolicies();
    expect(result.v1).toBeUndefined();
    expect(result.v2).toBeDefined();
    expect(result.v2.sampling?.temperature).toBe(0.9);
  });

  it('should round-trip all policy fields', () => {
    const policies: Record<string, PolicyConfig> = {
      full: {
        sampling: { temperature: 0.2, top_p: 0.5, top_k: 40 },
        output: {
          max_tokens: 2048,
          format: 'json_only',
          system_prompt_snippet: 'Be precise.',
          system_prompt_mode: 'append',
        },
        context: { context_threshold: 1000, compression_strategy: 'rolling_summary' },
        tool: { max_tool_iterations: 5, tool_mode: 'ask' },
        reliability: { retry_on_invalid_json: true, timeout: 30000 },
      },
    };
    saveCustomPolicies(policies);
    const loaded = loadCustomPolicies();
    expect(loaded.full).toEqual(policies.full);
  });
});

// ── resolvePolicy ────────────────────────────────────────────────────────────

describe('resolvePolicy', () => {
  it('should resolve built-in policies', () => {
    const precise = resolvePolicy('precise');
    expect(precise).toEqual(BUILTIN_POLICIES.precise);
  });

  it('should return null for unknown policy', () => {
    expect(resolvePolicy('nonexistent')).toBeNull();
  });

  it('should prefer custom over built-in when names differ', () => {
    const custom: Record<string, PolicyConfig> = {
      my_custom: { sampling: { temperature: 0.42 } },
    };
    saveCustomPolicies(custom);
    const result = resolvePolicy('my_custom');
    expect(result?.sampling?.temperature).toBe(0.42);
  });
});

// ── flattenPolicy ────────────────────────────────────────────────────────────

describe('flattenPolicy', () => {
  it('should flatten sampling params', () => {
    const flat = flattenPolicy({ sampling: { temperature: 0.3, top_p: 0.5, top_k: 10 } });
    expect(flat.params.temperature).toBe(0.3);
    expect(flat.params.top_p).toBe(0.5);
    expect(flat.params.top_k).toBe(10);
  });

  it('should flatten output fields', () => {
    const flat = flattenPolicy({
      output: {
        max_tokens: 4096,
        format: 'json_only',
        system_prompt_snippet: 'test',
        system_prompt_mode: 'append',
      },
    });
    expect(flat.params.max_tokens).toBe(4096);
    expect(flat.outputFormat).toBe('json_only');
    expect(flat.systemPromptSnippet).toBe('test');
    expect(flat.systemPromptMode).toBe('append');
  });

  it('should default systemPromptMode to prepend', () => {
    const flat = flattenPolicy({ output: { system_prompt_snippet: 'x' } });
    expect(flat.systemPromptMode).toBe('prepend');
  });

  it('should flatten reliability fields', () => {
    const flat = flattenPolicy({ reliability: { retry_on_invalid_json: true, timeout: 5000 } });
    expect(flat.retryOnInvalidJson).toBe(true);
    expect(flat.params.timeout).toBe(5000);
  });

  it('should flatten tool fields', () => {
    const flat = flattenPolicy({ tool: { tool_mode: 'ask', max_tool_iterations: 3 } });
    expect(flat.toolMode).toBe('ask');
    expect(flat.maxToolIterations).toBe(3);
  });

  it('should handle empty policy', () => {
    const flat = flattenPolicy({});
    expect(flat.params).toEqual({});
    expect(flat.systemPromptSnippet).toBeUndefined();
    expect(flat.outputFormat).toBeUndefined();
  });
});

// ── listAllPolicies ──────────────────────────────────────────────────────────

describe('listAllPolicies', () => {
  it('should include all built-in policies', () => {
    const all = listAllPolicies();
    for (const name of BUILTIN_POLICY_NAMES) {
      const entry = all.find((p) => p.name === name);
      expect(entry).toBeDefined();
      expect(entry!.builtin).toBe(true);
    }
  });

  it('should include custom policies', () => {
    saveCustomPolicies({ my_extra: { sampling: { temperature: 0.7 } } });
    const all = listAllPolicies();
    const custom = all.find((p) => p.name === 'my_extra');
    expect(custom).toBeDefined();
    expect(custom!.builtin).toBe(false);
  });

  it('should not include custom policies that shadow built-in names', () => {
    saveCustomPolicies({ precise: { sampling: { temperature: 0.99 } } });
    const all = listAllPolicies();
    const preciseEntries = all.filter((p) => p.name === 'precise');
    expect(preciseEntries).toHaveLength(1);
    expect(preciseEntries[0].builtin).toBe(true);
  });
});

// ── built-in policy integrity ────────────────────────────────────────────────

describe('built-in policies', () => {
  it('BUILTIN_POLICY_NAMES should match BUILTIN_POLICIES keys', () => {
    expect(BUILTIN_POLICY_NAMES).toEqual(Object.keys(BUILTIN_POLICIES));
  });

  it('json_strict should enable retry_on_invalid_json', () => {
    expect(BUILTIN_POLICIES.json_strict.reliability?.retry_on_invalid_json).toBe(true);
  });

  it('json_strict should set format to json_only', () => {
    expect(BUILTIN_POLICIES.json_strict.output?.format).toBe('json_only');
  });
});

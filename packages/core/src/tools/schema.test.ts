import { describe, expect, it } from 'vitest';
import { toolsForRole } from './scoping.js';
import { toolInputJsonSchema, toolOutputJsonSchema } from './schema.js';

describe('tool JSON-schema projections', () => {
  it('preserves the callable input contract while stripping prose-heavy metadata', () => {
    const send = toolsForRole('coordinator').find((tool) => tool.name === 'co_mail_send');
    expect(send).toBeDefined();

    const schema = toolInputJsonSchema(send!);
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('subject');
    expect(schema.properties).toHaveProperty('subject');

    const typeSchema = schema.properties?.type as { enum?: readonly string[] } | undefined;
    expect(typeSchema?.enum).toContain('chat');

    const encoded = JSON.stringify(schema);
    expect(encoded).not.toContain('"description"');
    expect(encoded).not.toContain('"$schema"');
    expect(encoded).not.toContain('"title"');
  });

  it('preserves compact machine-readable validation constraints', () => {
    const sling = toolsForRole('coordinator').find((tool) => tool.name === 'co_sling');
    expect(sling).toBeDefined();

    const schema = toolInputJsonSchema(sling!);
    const parent = schema.properties?.parent as { minLength?: number } | undefined;
    const branch = schema.properties?.branch as { pattern?: string } | undefined;

    expect(parent?.minLength).toBe(1);
    expect(branch?.pattern).toBe('^co\\/');
  });

  it('preserves input property names that overlap stripped metadata keys', () => {
    const draft = toolsForRole('coordinator').find((tool) => tool.name === 'co_spec_draft');
    expect(draft).toBeDefined();

    const schema = toolInputJsonSchema(draft!);
    const title = schema.properties?.title as { description?: unknown; minLength?: number };

    expect(schema.properties).toHaveProperty('title');
    expect(title.minLength).toBe(1);
    expect(title.description).toBeUndefined();
  });

  it('projects output schemas from the canonical zod object without wire-only bloat', () => {
    const sling = toolsForRole('coordinator').find((tool) => tool.name === 'co_sling');
    expect(sling).toBeDefined();

    const schema = toolOutputJsonSchema(sling!);
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('placement');

    const encoded = JSON.stringify(schema);
    expect(encoded).not.toContain('"description"');
    expect(encoded).not.toContain('"$schema"');
  });
});

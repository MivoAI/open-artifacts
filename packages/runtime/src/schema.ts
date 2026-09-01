import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Constructor } from 'ajv/dist/2020.js';

import type { JsonSchema } from '@open-artifacts/sdk';

import { RuntimeError } from './errors.js';
import { stableJson } from './stable-json.js';

const Ajv2020 = Ajv2020Import as unknown as typeof Ajv2020Constructor;
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
const validators = new Map<string, ValidateFunction>();

function validatorFor(schema: JsonSchema) {
  const key = stableJson(schema);
  const existing = validators.get(key);
  if (existing) return existing;
  const validator = ajv.compile(schema as AnySchema);
  validators.set(key, validator);
  return validator;
}

function formatIssue(error: ErrorObject) {
  const location = error.instancePath ? `$${error.instancePath}` : '$';
  return `${location} ${error.message ?? 'does not match the Schema'}`;
}

export function validateSchema(
  schema: JsonSchema,
  value: unknown,
  code: 'DATA_SCHEMA_INVALID' | 'TOOL_INPUT_INVALID' | 'TOOL_OUTPUT_INVALID',
) {
  let validator: ValidateFunction;
  try {
    validator = validatorFor(schema);
  } catch (error) {
    throw new RuntimeError(
      code,
      `${code}: Package supplied an invalid JSON Schema`,
      error instanceof Error ? { schemaError: error.message } : undefined,
    );
  }
  if (validator(value)) return;
  const issues = (validator.errors ?? []).map(formatIssue);
  throw new RuntimeError(code, `${code}: ${issues.join('; ')}`, { issues });
}
